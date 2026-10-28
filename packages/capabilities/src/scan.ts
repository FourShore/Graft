import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import type { Tree } from "./tree.js";
import { BUILTINS, PACKAGES, packageGrants, packageName, type Capability } from "./table.js";

/** One reason a file holds a capability: the import or call that grants it. */
export interface Grant {
  cap: Capability;
  /** 1-based line of the import or call. */
  line: number;
  /** What grants it, for the finding: "imports node:child_process", "calls fetch", "reads process.env". */
  why: string;
  /** For `dep`: the package the table does not know; part of the grant's identity, so two unknown packages are two grants. */
  pkg?: string;
}

/** What one source file holds on its own, and the project files it imports. */
export interface Scan {
  grants: Grant[];
  /** Relative imports, to be resolved against the tree and inherited one level. */
  imports: { specifier: string; line: number }[];
}

export interface ScanOptions {
  /** Packages beyond the built-in table, from the manifest. */
  packages?: Readonly<Record<string, readonly Capability[]>>;
  /** The repository's own package names (its workspaces): project code, which grants nothing by name. */
  internal?: ReadonlySet<string>;
  /** tsconfig `paths` aliases (`@/*` to `src/*`): project code, resolved and inherited like a relative import. */
  aliases?: readonly Alias[];
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};

/** The extensions the scanner reads; any other file holds nothing as far as it can tell. */
export const SOURCE_EXTENSIONS = Object.keys(SCRIPT_KINDS);

export function isSourcePath(path: string): boolean {
  return scriptKind(path) !== undefined && !/(^|\/)node_modules\//.test(path);
}

function scriptKind(path: string): ts.ScriptKind | undefined {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? undefined : SCRIPT_KINDS[path.slice(dot)];
}

const NODE_BUILTINS = new Set(builtinModules.map((m) => m.replace(/^node:/, "")));

/** The key a grant is compared by between before and after: the capability, or the package for `dep`. */
export function grantKey(g: Grant): string {
  return g.cap === "dep" ? `dep:${g.pkg}` : g.cap;
}

/**
 * The capabilities one file holds directly: by the modules it imports (static
 * imports, re-exports, `require` and `import()` with a literal argument) and
 * the globals it uses (`fetch`, `process.env`, `eval`...). Type-only imports
 * grant nothing. A name the file binds itself (its own `fetch`, a parameter
 * called `process`) is not the global where that binding is in scope; a
 * `require` made by `createRequire` and a `process` imported from
 * `node:process` are the real thing under any name. Parsing is syntax only: no
 * type checker, no resolution of what a helper returns, so a `require` passed
 * through a helper is missed, on purpose.
 */
export function scanSource(path: string, text: string, opts: ScanOptions = {}): Scan {
  const kind = scriptKind(path);
  const grants: Grant[] = [];
  const imports: Scan["imports"] = [];
  if (kind === undefined) return { grants, imports };
  const table = opts.packages ? { ...PACKAGES, ...opts.packages } : PACKAGES;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const scopes = new Scopes();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const seen = new Set<string>();
  const grant = (cap: Capability, line: number, why: string, pkg?: string) => {
    // One grant per reason per capability: the first line that grants it.
    const id = `${cap}:${pkg ?? ""}:${why}`;
    if (seen.has(id)) return;
    seen.add(id);
    grants.push({ cap, line, why, ...(pkg ? { pkg } : {}) });
  };

  const specifier = (raw: string, line: number) => {
    if (raw.endsWith(".node")) {
      grant("native", line, `imports ${raw}`);
      return;
    }
    if (raw.startsWith(".") || raw.startsWith("/")) {
      imports.push({ specifier: raw, line });
      return;
    }
    const alias = opts.aliases && resolveAlias(raw, opts.aliases);
    if (alias) {
      imports.push({ specifier: `/${alias}`, line });
      return;
    }
    const name = raw.replace(/^node:/, "");
    if (raw.startsWith("node:") || NODE_BUILTINS.has(name)) {
      for (const cap of Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : []) grant(cap, line, `imports node:${name}`);
      return;
    }
    if (raw.startsWith("#") || raw.startsWith("bun:") || raw.startsWith("deno:") || raw.startsWith("npm:") || raw.startsWith("jsr:")) return;
    const pkg = packageName(raw);
    if (opts.internal?.has(pkg)) return;
    const caps = packageGrants(pkg, table);
    if (caps) for (const cap of caps) grant(cap, line, `imports ${pkg}`);
    else grant("dep", line, `imports ${pkg}, which the table does not know`, pkg);
  };

  /** The global an expression names: `fetch` for a free `fetch`, or for `globalThis.fetch`; undefined when a local binding is in scope. */
  const globalName = (e: ts.Expression): string | undefined => {
    if (ts.isIdentifier(e)) return scopes.lookup(e) ? undefined : e.text;
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression) && GLOBAL_OBJECTS.has(e.expression.text) && !scopes.lookup(e.expression)) return e.name.text;
    return undefined;
  };
  /** Whether an expression is `require`: the free one, or one `createRequire` made, under whatever name. */
  const isRequire = (e: ts.Expression): boolean => {
    if (globalName(e) === "require") return true;
    if (!ts.isIdentifier(e)) return false;
    const decl = scopes.lookup(e);
    return !!decl && ts.isVariableDeclaration(decl) && !!decl.initializer && isCreateRequire(decl.initializer);
  };
  /** Whether an expression is the `process` object: the global, or one imported or required from the process module. */
  const isProcess = (e: ts.Expression): boolean => {
    if (globalName(e) === "process") return true;
    if (!ts.isIdentifier(e)) return false;
    const decl = scopes.lookup(e);
    if (!decl) return false;
    if (ts.isImportClause(decl) || ts.isNamespaceImport(decl) || ts.isImportSpecifier(decl)) {
      if (ts.isImportSpecifier(decl) && (decl.propertyName ?? decl.name).text !== "default") return false;
      const from = importOf(decl);
      return !!from && isProcessModule(from);
    }
    if (ts.isImportEqualsDeclaration(decl)) {
      const ref = decl.moduleReference;
      return ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression) && isProcessModule(ref.expression.text);
    }
    if (ts.isVariableDeclaration(decl) && decl.initializer && ts.isCallExpression(decl.initializer)) {
      const call = decl.initializer;
      return isRequire(call.expression) && !!call.arguments[0] && ts.isStringLiteralLike(call.arguments[0]) && isProcessModule(call.arguments[0].text);
    }
    return false;
  };
  /** A member of `process`, read as a property, by destructuring, or as a named import of `node:process`. */
  const processMember = (member: string, line: number) => {
    if (member === "env") grant("env", line, "reads process.env");
    else if (member === "exit" || member === "kill" || member === "abort") grant("process", line, `calls process.${member}`);
    else if (member === "dlopen" || member === "binding") grant("native", line, `calls process.${member}`);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!isTypeOnlyImport(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        specifier(node.moduleSpecifier.text, lineOf(node));
        const bindings = node.importClause?.namedBindings;
        if (isProcessModule(node.moduleSpecifier.text) && bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) if (!el.isTypeOnly) processMember((el.propertyName ?? el.name).text, lineOf(node));
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!isTypeOnlyExport(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier(node.moduleSpecifier.text, lineOf(node));
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) specifier(ref.expression.text, lineOf(node));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg && ts.isStringLiteralLike(arg)) specifier(arg.text, lineOf(node));
        else grant("eval", lineOf(node), "calls import() with a computed argument");
      } else if (isRequire(callee)) {
        if (arg && ts.isStringLiteralLike(arg)) specifier(arg.text, lineOf(node));
        else grant("eval", lineOf(node), "calls require() with a computed argument");
      } else {
        const g = globalName(callee);
        if (g === "fetch") grant("net", lineOf(node), "calls fetch");
        else if (g === "eval") grant("eval", lineOf(node), "calls eval");
        else if (g === "Function") grant("eval", lineOf(node), "calls Function");
      }
    } else if (ts.isNewExpression(node)) {
      const g = globalName(node.expression);
      if (g === "Function") grant("eval", lineOf(node), "calls new Function");
      else if (g === "WebSocket" || g === "XMLHttpRequest" || g === "EventSource") grant("net", lineOf(node), `opens a ${g}`);
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isProcess(node.expression)) {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "";
      processMember(member, lineOf(node));
    } else if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isProcess(node.initializer)) {
      for (const el of node.name.elements) {
        const key = el.propertyName ?? el.name;
        if (ts.isIdentifier(key) || ts.isStringLiteral(key)) processMember(key.text, lineOf(node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { grants, imports };
}

/** Objects whose properties are the globals: `globalThis.fetch` is `fetch`. */
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);

function isProcessModule(specifier: string): boolean {
  return specifier === "process" || specifier === "node:process";
}

function isCreateRequire(e: ts.Expression): boolean {
  if (!ts.isCallExpression(e)) return false;
  const c = e.expression;
  return (ts.isIdentifier(c) && c.text === "createRequire") || (ts.isPropertyAccessExpression(c) && c.name.text === "createRequire");
}

function importOf(decl: ts.ImportClause | ts.NamespaceImport | ts.ImportSpecifier): string | undefined {
  let n: ts.Node = decl;
  while (n && !ts.isImportDeclaration(n)) n = n.parent;
  return n && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined;
}

/** `import type { A }` and `import { type A, type B }`: nothing is loaded at run time. `import {} from "x"` still loads x. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const b = clause.namedBindings;
  return !clause.name && !!b && ts.isNamedImports(b) && b.elements.length > 0 && b.elements.every((e) => e.isTypeOnly);
}

function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  const c = node.exportClause;
  return !!c && ts.isNamedExports(c) && c.elements.length > 0 && c.elements.every((e) => e.isTypeOnly);
}

/** A tsconfig `paths` alias to the repo path it names (no leading slash), or undefined when no alias matches. */
export function resolveAlias(specifier: string, aliases: readonly Alias[]): string | undefined {
  for (const a of aliases) {
    const star = a.pattern.indexOf("*");
    if (star < 0) {
      if (specifier === a.pattern) return a.target;
      continue;
    }
    const pre = a.pattern.slice(0, star);
    const post = a.pattern.slice(star + 1);
    if (specifier.length >= pre.length + post.length && specifier.startsWith(pre) && specifier.endsWith(post)) {
      return a.target.replace("*", specifier.slice(pre.length, specifier.length - post.length));
    }
  }
  return undefined;
}

/** One tsconfig `paths` entry, its first target made relative to the repo root. */
export interface Alias {
  pattern: string;
  target: string;
}

/**
 * Lexical scopes, enough to tell a local binding from a global: a name an
 * enclosing block, function, catch clause, loop, class or the module binds.
 * `var` and function declarations are hoisted to their function.
 */
class Scopes {
  private cache = new Map<ts.Node, Map<string, ts.Node>>();

  /** The declaration a name refers to, or undefined when no enclosing scope binds it. */
  lookup(id: ts.Identifier): ts.Node | undefined {
    for (let n: ts.Node | undefined = id.parent; n; n = n.parent) {
      const decl = this.bindings(n).get(id.text);
      if (decl) return decl;
    }
    return undefined;
  }

  private bindings(n: ts.Node): Map<string, ts.Node> {
    let m = this.cache.get(n);
    if (m) return m;
    m = new Map();
    this.cache.set(n, m);
    const add = (name: ts.BindingName | ts.Identifier | undefined, decl: ts.Node) => {
      if (!name) return;
      if (ts.isIdentifier(name)) {
        if (!m!.has(name.text)) m!.set(name.text, decl);
        return;
      }
      for (const el of name.elements) if (!ts.isOmittedExpression(el)) add(el.name, el);
    };
    const addVar = (d: ts.VariableDeclaration) => add(d.name, d);
    const lexical = (stmts: readonly ts.Statement[]) => {
      for (const s of stmts) {
        if (ts.isVariableStatement(s) && s.declarationList.flags & ts.NodeFlags.BlockScoped) s.declarationList.declarations.forEach(addVar);
        else if (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s)) add(s.name, s);
      }
    };
    // `var` declarations anywhere in a function or module body, not crossing into nested functions.
    const hoisted = (root: ts.Node) => {
      const walk = (x: ts.Node) => {
        if (x !== root && isFunctionLike(x)) return;
        if (ts.isVariableDeclarationList(x) && !(x.flags & ts.NodeFlags.BlockScoped)) x.declarations.forEach(addVar);
        else if (x !== root && ts.isFunctionDeclaration(x)) add(x.name, x);
        ts.forEachChild(x, walk);
      };
      ts.forEachChild(root, walk);
    };
    if (ts.isSourceFile(n) || ts.isModuleBlock(n)) {
      for (const s of n.statements) {
        if (ts.isImportDeclaration(s) && s.importClause && !s.importClause.isTypeOnly) {
          const c = s.importClause;
          if (c.name) add(c.name, c);
          const b = c.namedBindings;
          if (b && ts.isNamespaceImport(b)) add(b.name, b);
          else if (b && ts.isNamedImports(b)) for (const el of b.elements) if (!el.isTypeOnly) add(el.name, el);
        } else if (ts.isImportEqualsDeclaration(s) && !s.isTypeOnly) add(s.name, s);
      }
      lexical(n.statements);
      hoisted(n);
    } else if (isFunctionLike(n)) {
      if (ts.isFunctionExpression(n) && n.name) add(n.name, n);
      for (const p of n.parameters) add(p.name, p);
      if (n.body) {
        if (ts.isBlock(n.body)) lexical(n.body.statements);
        hoisted(n.body);
      }
    } else if (ts.isBlock(n) && !(n.parent && isFunctionLike(n.parent))) {
      lexical(n.statements);
    } else if (ts.isCaseBlock(n)) {
      for (const c of n.clauses) lexical(c.statements);
    } else if ((ts.isForStatement(n) || ts.isForInStatement(n) || ts.isForOfStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
      if (n.initializer.flags & ts.NodeFlags.BlockScoped) n.initializer.declarations.forEach(addVar);
    } else if (ts.isCatchClause(n) && n.variableDeclaration) {
      add(n.variableDeclaration.name, n.variableDeclaration);
    } else if (ts.isClassExpression(n) && n.name) {
      add(n.name, n);
    }
    return m;
  }
}

function isFunctionLike(n: ts.Node): n is ts.FunctionLikeDeclaration {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n);
}

/** The root tsconfig.json's `paths`, each to its first target relative to the repo root: `@/*` to `src/*`. */
export async function pathAliases(tree: Tree): Promise<Alias[]> {
  const text = await tree.read("tsconfig.json");
  if (text === null) return [];
  const { config } = ts.parseConfigFileTextToJson("tsconfig.json", text);
  const options = (config as { compilerOptions?: { baseUrl?: unknown; paths?: unknown } } | undefined)?.compilerOptions;
  const paths = options?.paths;
  if (!paths || typeof paths !== "object") return [];
  const baseUrl = typeof options.baseUrl === "string" ? options.baseUrl : ".";
  const out: Alias[] = [];
  for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
    const first = Array.isArray(targets) ? targets.find((t): t is string => typeof t === "string") : undefined;
    if (!first) continue;
    const target = posix.normalize(posix.join(baseUrl, first)).replace(/^\.\//, "");
    if (target === ".." || target.startsWith("../")) continue;
    out.push({ pattern, target });
  }
  return out;
}


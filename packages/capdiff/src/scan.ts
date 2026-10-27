import { builtinModules } from "node:module";
import ts from "typescript";
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
 * grant nothing. A global the file declares itself (its own `fetch`) is not the
 * global. Parsing is syntax only: no type checker, no resolution of what a
 * helper returns, so a `require` through an alias is missed, on purpose.
 */
export function scanSource(path: string, text: string, opts: ScanOptions = {}): Scan {
  const kind = scriptKind(path);
  const grants: Grant[] = [];
  const imports: Scan["imports"] = [];
  if (kind === undefined) return { grants, imports };
  const table = opts.packages ? { ...PACKAGES, ...opts.packages } : PACKAGES;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const declared = declaredNames(sf);
  const isGlobal = (name: string) => !declared.has(name);
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
    const name = raw.replace(/^node:/, "");
    if (raw.startsWith("node:") || NODE_BUILTINS.has(name)) {
      for (const cap of BUILTINS[name] ?? []) grant(cap, line, `imports node:${name}`);
      return;
    }
    if (raw.startsWith("#") || raw.startsWith("bun:") || raw.startsWith("deno:") || raw.startsWith("npm:") || raw.startsWith("jsr:")) return;
    const pkg = packageName(raw);
    if (opts.internal?.has(pkg)) return;
    const caps = packageGrants(pkg, table);
    if (caps) for (const cap of caps) grant(cap, line, `imports ${pkg}`);
    else grant("dep", line, `imports ${pkg}, which the table does not know`, pkg);
  };

  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) specifier(node.moduleSpecifier.text, lineOf(node));
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier(node.moduleSpecifier.text, lineOf(node));
    } else if (ts.isImportEqualsDeclaration(node)) {
      const ref = node.moduleReference;
      if (!node.isTypeOnly && ts.isExternalModuleReference(ref) && ts.isStringLiteral(ref.expression)) specifier(ref.expression.text, lineOf(node));
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const arg = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        if (arg && ts.isStringLiteralLike(arg)) specifier(arg.text, lineOf(node));
        else grant("eval", lineOf(node), "calls import() with a computed argument");
      } else if (ts.isIdentifier(callee) && isGlobal(callee.text)) {
        if (callee.text === "require") {
          if (arg && ts.isStringLiteralLike(arg)) specifier(arg.text, lineOf(node));
          else grant("eval", lineOf(node), "calls require() with a computed argument");
        } else if (callee.text === "fetch") grant("net", lineOf(node), "calls fetch");
        else if (callee.text === "eval") grant("eval", lineOf(node), "calls eval");
        else if (callee.text === "Function") grant("eval", lineOf(node), "calls Function");
      } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "globalThis" && callee.name.text === "fetch") {
        grant("net", lineOf(node), "calls fetch");
      }
    } else if (ts.isNewExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && isGlobal(callee.text)) {
        if (callee.text === "Function") grant("eval", lineOf(node), "calls new Function");
        else if (callee.text === "WebSocket" || callee.text === "XMLHttpRequest" || callee.text === "EventSource") grant("net", lineOf(node), `opens a ${callee.text}`);
      }
    } else if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === "process" && isGlobal("process")) {
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isStringLiteralLike(node.argumentExpression) ? node.argumentExpression.text : "";
      if (member === "env") grant("env", lineOf(node), "reads process.env");
      else if (member === "exit" || member === "kill" || member === "abort") grant("process", lineOf(node), `calls process.${member}`);
      else if (member === "dlopen" || member === "binding") grant("native", lineOf(node), `calls process.${member}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { grants, imports };
}

/** Every name the file binds itself: a `fetch` it declares is not the global one. */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      const p = node.parent;
      if (
        p &&
        (ts.isVariableDeclaration(p) ||
          ts.isFunctionDeclaration(p) ||
          ts.isFunctionExpression(p) ||
          ts.isClassDeclaration(p) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p) ||
          ts.isImportClause(p) ||
          ts.isImportSpecifier(p) ||
          ts.isNamespaceImport(p) ||
          ts.isImportEqualsDeclaration(p) ||
          ts.isEnumDeclaration(p)) &&
        p.name === node
      ) {
        names.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

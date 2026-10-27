/**
 * What grants a capability. A capability is a coarse category of effect,
 * deliberately few, so a reviewer can read a file's set at a glance:
 *
 *   fs       reads or writes the file system
 *   net      talks to the network: a server, a client, a socket
 *   process  starts or ends processes and threads
 *   env      reads the environment
 *   eval     turns strings into code
 *   native   loads compiled code
 *   dep      imports a third-party package this table does not know
 *
 * Node built-ins grant by module name; third-party packages by the table
 * below, which a repo extends in its manifest (`"packages"`). An unknown
 * package grants `dep`, and the finding names it, so the table grows from what
 * people hit rather than from guesswork.
 */
export type Capability = "fs" | "net" | "process" | "env" | "eval" | "native" | "dep";

export const CAPABILITIES: readonly Capability[] = ["fs", "net", "process", "env", "eval", "native", "dep"];

export function isCapability(s: string): s is Capability {
  return (CAPABILITIES as readonly string[]).includes(s);
}

/** Node built-in modules that grant a capability; a built-in missing here (path, os, crypto, util...) grants nothing. */
export const BUILTINS: Readonly<Record<string, readonly Capability[]>> = {
  fs: ["fs"],
  "fs/promises": ["fs"],
  http: ["net"],
  https: ["net"],
  http2: ["net"],
  net: ["net"],
  dns: ["net"],
  "dns/promises": ["net"],
  tls: ["net"],
  dgram: ["net"],
  child_process: ["process"],
  worker_threads: ["process"],
  cluster: ["process"],
  vm: ["eval"],
};

/**
 * Third-party packages and what they grant. Exact names; a scoped prefix ends
 * in `/*` and matches every package under the scope. Kept short on purpose:
 * the common ways a Node program reaches outside itself.
 */
export const PACKAGES: Readonly<Record<string, readonly Capability[]>> = {
  // HTTP clients and sockets
  undici: ["net"],
  "node-fetch": ["net"],
  "cross-fetch": ["net"],
  "isomorphic-fetch": ["net"],
  axios: ["net"],
  got: ["net"],
  ky: ["net"],
  superagent: ["net"],
  request: ["net"],
  needle: ["net"],
  phin: ["net"],
  ws: ["net"],
  "socket.io": ["net"],
  "socket.io-client": ["net"],
  // Servers
  express: ["net"],
  fastify: ["net"],
  koa: ["net"],
  "@hapi/hapi": ["net"],
  "http-proxy": ["net"],
  "http-proxy-middleware": ["net"],
  // API clients
  "@anthropic-ai/sdk": ["net"],
  openai: ["net"],
  "@google/generative-ai": ["net"],
  "@google/genai": ["net"],
  "@octokit/*": ["net"],
  octokit: ["net"],
  "@aws-sdk/*": ["net"],
  "aws-sdk": ["net"],
  "@azure/*": ["net"],
  "@google-cloud/*": ["net"],
  googleapis: ["net"],
  "@supabase/supabase-js": ["net"],
  firebase: ["net"],
  "firebase-admin": ["net"],
  stripe: ["net"],
  twilio: ["net"],
  nodemailer: ["net"],
  "@slack/web-api": ["net"],
  "@modelcontextprotocol/sdk": ["net"],
  // Databases
  pg: ["net"],
  mysql: ["net"],
  mysql2: ["net"],
  mongodb: ["net"],
  mongoose: ["net"],
  redis: ["net"],
  ioredis: ["net"],
  "better-sqlite3": ["native", "fs"],
  sqlite3: ["native", "fs"],
  // Processes
  execa: ["process"],
  "cross-spawn": ["process"],
  tinyexec: ["process"],
  "nano-spawn": ["process"],
  shelljs: ["process", "fs"],
  zx: ["process", "fs", "net"],
  "node-pty": ["process", "native"],
  puppeteer: ["process", "net"],
  "puppeteer-core": ["process", "net"],
  playwright: ["process", "net"],
  "playwright-core": ["process", "net"],
  "@playwright/test": ["process", "net"],
  esbuild: ["process", "fs"],
  // Environment
  dotenv: ["env", "fs"],
  "dotenv-expand": ["env"],
  "@dotenvx/dotenvx": ["env", "fs"],
  "cross-env": ["env", "process"],
  envalid: ["env"],
  // File system
  "fs-extra": ["fs"],
  "graceful-fs": ["fs"],
  glob: ["fs"],
  "fast-glob": ["fs"],
  globby: ["fs"],
  tinyglobby: ["fs"],
  fdir: ["fs"],
  chokidar: ["fs"],
  "@parcel/watcher": ["fs", "native"],
  rimraf: ["fs"],
  mkdirp: ["fs"],
  tmp: ["fs"],
  "write-file-atomic": ["fs"],
  typescript: ["fs"],
  "@babel/core": ["fs"],
  // Code from strings
  vm2: ["eval"],
  "isolated-vm": ["eval", "native"],
  "safe-eval": ["eval"],
  // Compiled code
  "ffi-napi": ["native"],
  koffi: ["native"],
  bindings: ["native"],
  "node-gyp-build": ["native"],
  "node-addon-api": ["native"],
  sharp: ["native", "fs"],
  bcrypt: ["native"],
  // Libraries that reach nothing outside the program: listed so a file that imports one is not reported as holding `dep`.
  vitest: [],
  "@vitest/*": [],
  jest: [],
  "@jest/*": [],
  mocha: [],
  chai: [],
  sinon: [],
  "@types/*": [],
  tslib: [],
  zod: [],
  yup: [],
  joi: [],
  ajv: [],
  commander: [],
  yargs: [],
  minimist: [],
  lodash: [],
  "lodash-es": [],
  ramda: [],
  immer: [],
  rxjs: [],
  dayjs: [],
  "date-fns": [],
  luxon: [],
  moment: [],
  uuid: [],
  nanoid: [],
  semver: [],
  ms: [],
  yaml: [],
  "js-yaml": [],
  chalk: [],
  picocolors: [],
  kleur: [],
  "strip-ansi": [],
  "string-width": [],
  "p-limit": [],
  "p-map": [],
  "p-queue": [],
  react: [],
  "react-dom": [],
  vue: [],
  svelte: [],
  preact: [],
};

/** What a package grants under a table: exact name first, then a scoped `@scope/*` entry; undefined when unknown. */
export function packageGrants(name: string, table: Readonly<Record<string, readonly Capability[]>>): readonly Capability[] | undefined {
  if (table[name]) return table[name];
  const slash = name.indexOf("/");
  if (name.startsWith("@") && slash > 0) return table[`${name.slice(0, slash)}/*`];
  return undefined;
}

/** The package name in a bare specifier: `lodash/fp` is `lodash`, `@scope/pkg/sub` is `@scope/pkg`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

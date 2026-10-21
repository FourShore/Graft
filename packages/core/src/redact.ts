/**
 * Keep secrets out of records. Two cheap guards for version 1:
 *
 *  - Evidence output and notes are scrubbed of the values of environment
 *    variables whose names look secret, since commands run with the agent's
 *    full environment and a verbose failure can echo config.
 *  - Landing refuses files whose names look like credentials, since a weak
 *    .gitignore plus "stage everything" is how a .env ends up in history.
 *
 * Neither is a substitute for a secret scanner; they catch the common case.
 */

// Names that hold a secret, not names that merely mention auth: AUTH_SERVER_URI
// is a public address, AUTH_TOKEN is caught by TOKEN.
const SECRET_ENV_NAME = /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|SIGNING_?KEY|CREDENTIALS?)(_|$)|(^|_)KEY$/i;
const MIN_SECRET_LENGTH = 8;

/** Values of environment variables that look like secrets, longest first. */
export function secretEnvValues(env: NodeJS.ProcessEnv = process.env): { name: string; value: string }[] {
  const found: { name: string; value: string }[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (!SECRET_ENV_NAME.test(name)) continue;
    found.push({ name, value });
  }
  return found.sort((a, b) => b.value.length - a.value.length);
}

/**
 * Credentials that look like themselves wherever they appear, so a token
 * pasted into a prompt or typed on a command line is caught even when no
 * environment variable holds it. Each keeps a label and drops the value.
 */
const TOKEN_PATTERNS: [RegExp, string | ((...m: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, "[redacted Anthropic key]"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, "[redacted API key]"],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/g, "[redacted GitHub token]"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "[redacted Slack token]"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[redacted AWS key]"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, "[redacted Google key]"],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, "[redacted npm token]"],
  // scheme://user:password@host keeps the user and host.
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, (_m, head) => `${head}[redacted]@`],
  // --password=x, password: x, api_key=x keep the key.
  [/((?:--?)?\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|auth[-_]?token)\b\s*[=:]\s*)(?!\[redacted)("[^"]*"|'[^']*'|[^\s'"&;]+)/gi, (_m, head) => `${head}[redacted]`],
];

/**
 * A prompt as a captured task may keep it: links become `[link to host]` and
 * email addresses `[email]`, since a prompt carries ticket URLs, document
 * links and people's addresses that would otherwise become pushed history.
 * The host is kept so a reader still knows where the link pointed. A task
 * named with `graft start` is the author's own words and is not scrubbed.
 */
export function scrubPrompt(text: string): string {
  return text
    // Sentence punctuation after a link is the sentence's, not the link's.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s/@]*@)?([^\s/:?#)\]>"',;]+)[^\s)\]>"']*?([.,;:!?]*)(?=[\s)\]>"']|$)/gi, (_m, host: string, tail: string) => `[link to ${host.toLowerCase().replace(/\.+$/, "")}]${tail}`)
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]");
}

/**
 * Replace every occurrence of a secret-looking env value with a marker naming
 * the variable, and every well-known credential format with a marker naming
 * its kind. Applied to everything a record keeps: task, plan, commands,
 * labels, notes and output, since the commit message is pushed history.
 */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const { name, value } of secretEnvValues(env)) {
    out = out.split(value).join(`[redacted ${name}]`);
  }
  for (const [re, to] of TOKEN_PATTERNS) out = typeof to === "string" ? out.replace(re, to) : out.replace(re, to);
  return out;
}

const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/, // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(credentials|service-account[^/]*)\.json$/i,
  /(^|\/)\.(npmrc|pypirc|netrc)$/,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.git-credentials$/,
  /(^|\/)(\.kube\/config|kubeconfig(\.ya?ml)?)$/,
  /\.tfvars(\.json)?$/, // terraform.tfvars, prod.auto.tfvars; not *.tfvars.example
];

/**
 * True if a path looks like it holds credentials rather than code. `extra`
 * are repo-specific globs from policy: a pattern without a slash matches the
 * file name anywhere in the tree, one with a slash is anchored at the root.
 */
export function looksLikeSecretFile(path: string, extra: string[] = []): boolean {
  const p = path.replace(/\\/g, "/");
  if (/(^|\/)\.env\.(example|sample|template)$/.test(p)) return false;
  return SECRET_FILE_PATTERNS.some((re) => re.test(p)) || extra.some((g) => globToRegExp(g).test(p));
}

/**
 * The words of a shell command that name a credential file, so the output of
 * `cat nova.json && go test ./...` is withheld from the record instead of
 * copying the key into history. Quotes and `--flag=` prefixes are stripped;
 * the split is on whitespace and shell operators, not a real parse.
 */
export function secretFilesNamed(command: string, extra: string[] = []): string[] {
  const words = command
    .split(/[\s;&|<>()`=]+/)
    .map((w) => w.replace(/^["']+|["']+$/g, ""))
    .filter((w) => w && !w.startsWith("-"));
  return [...new Set(words.filter((w) => looksLikeSecretFile(w, extra)))];
}

/** Minimal glob: `**` spans directories (`a/**` is everything under a), `*` and `?` stay within one segment. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\*\*/g, "\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?")
    .replace(/\u0001/g, ".*");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`);
}

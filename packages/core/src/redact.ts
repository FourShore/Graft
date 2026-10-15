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

/** Replace every occurrence of a secret-looking env value with a marker naming the variable. */
export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const { name, value } of secretEnvValues(env)) {
    out = out.split(value).join(`[redacted ${name}]`);
  }
  return out;
}

const SECRET_FILE_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/, // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /(^|\/)(credentials|service-account[^/]*)\.json$/i,
  /(^|\/)\.(npmrc|pypirc|netrc)$/,
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

/** Minimal glob: `**` spans directories, `*` and `?` stay within one segment. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\/?/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0000/g, "(?:.*/)?");
  return new RegExp(glob.includes("/") ? `^${body}$` : `(^|/)${body}$`);
}

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import type { ChangeAuthor, ReviewFinding } from "./record.js";

/**
 * A review the policy names: an independent reading of the change by a model
 * (or any command that answers the same way), recorded as evidence next to
 * the author's own runs. `graft evidence <name>` runs one on the working
 * tree; `graft check --rerun` runs it again on each commit, and that run is
 * the one that counts.
 */
export interface ReviewSpec {
  /** The model that reviews. Default: DEFAULT_REVIEW_MODEL. */
  model?: string;
  /**
   * Path, relative to the repo root, of the instructions the reviewer is given
   * instead of the built-in ones. The record carries the hash of whichever
   * was used, so a reader knows which instructions judged a change.
   */
  prompt?: string;
  /**
   * A command to run instead of the API: it reads a ReviewRequest as JSON on
   * stdin and prints a ReviewResult as JSON. For a reviewer behind another
   * gateway, a local model, or a test.
   */
  command?: string;
  /**
   * Refuse a review by the model that wrote the change: the reviewer must run
   * on a different model from the one in the record's `author.model`. An
   * agent author whose model is not recorded cannot be told apart, so its
   * review is refused too; a human author needs no check.
   */
  differentModel?: boolean;
}

export interface ReviewRequest {
  /** The policy's name for this review. */
  name: string;
  /** The task the change was given. */
  task: string;
  /** The unified diff under review, cut to REVIEW_DIFF_CAP characters with a marker when longer. */
  diff: string;
  /** The instructions the reviewer works under: the policy's prompt file, or the built-in prompt. */
  instructions: string;
}

export interface ReviewResult {
  /** The model that reviewed, as the API reported it, or as the command named it. */
  model: string;
  verdict: "approve" | "request-changes";
  summary: string;
  findings: ReviewFinding[];
}

export const DEFAULT_REVIEW_MODEL = "claude-opus-5-5";

/** Characters of diff a reviewer is shown; past this the rest is replaced with a marker that says how much was cut. */
export const REVIEW_DIFF_CAP = 400_000;

/** The instructions a review runs under when the policy names no prompt file. Its hash goes in every record. */
export const DEFAULT_REVIEW_PROMPT = `You are reviewing one change to a codebase before it lands. You are given the task the author was set and the diff they produced. You are the independent check: the author's tests ran, and your job is what tests do not catch.

Read the whole diff before judging any of it. Then decide:

1. Does the diff do what the task asked, no less and no more? Note anything the task asked for that is missing, and anything the diff changes that the task did not call for.
2. Is it correct? Look for logic errors, off-by-one and boundary cases, unhandled errors, races, resource leaks, and behavior that differs from what the surrounding code expects.
3. Is it safe? Look for injection (shell, SQL, path), secrets written into code or logs, data exposed that was not before, and checks that were weakened or removed.
4. Were tests weakened? A deleted assertion, a widened tolerance, a skipped test or a test that no longer exercises the changed path is a blocker on its own.
5. Would a maintainer understand it? Only raise this where it would cause a mistake later.

Report findings, not a narrative. Each finding is one problem with its file and line when it concerns one place, in one or two plain sentences that say what is wrong and why it matters. Rate each one:
- blocker: wrong, unsafe, or does not do the task; must change before landing.
- warning: likely to cause a bug or a mistake later; should change.
- nit: may change.

The verdict is request-changes when there is at least one blocker, and approve otherwise. Do not request changes for style, naming or taste. Do not approve to be polite: an empty findings list means you read everything and found nothing. The summary is one or two sentences a reader sees first: what the change does and whether it is ready.`;

/** The shape every reviewer answers in: what the API is asked for, and what a reviewer command must print. */
export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "request-changes"] },
    summary: { type: "string", description: "One or two sentences: what the change does and whether it is ready." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "warning", "nit"] },
          file: { type: "string", description: "Path relative to the repository root, when the finding is about one file." },
          line: { type: "integer", description: "Line in the new version of that file." },
          text: { type: "string", description: "What is wrong and why it matters." },
        },
        required: ["severity", "text"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdict", "summary", "findings"],
  additionalProperties: false,
} as const;

/** The review could not be run at all (no API key): a check reports it as not re-run rather than failed. */
export class ReviewUnavailableError extends Error {}

/** The review ran and went wrong (a refusal, a reviewer command that died, an answer that is not a review). */
export class ReviewError extends Error {}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The instructions for a review: the policy's prompt file read from the repo, or the built-in prompt. */
export async function loadReviewPrompt(spec: ReviewSpec, topLevel: string): Promise<string> {
  if (!spec.prompt) return DEFAULT_REVIEW_PROMPT;
  const path = isAbsolute(spec.prompt) ? spec.prompt : join(topLevel, spec.prompt);
  try {
    const text = await readFile(path, "utf8");
    if (!text.trim()) throw new ReviewError(`The review prompt ${spec.prompt} is empty.`);
    return text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new ReviewError(`The review prompt ${spec.prompt} does not exist in this checkout.`);
    throw err;
  }
}

/** The diff as a reviewer sees it: whole when it fits, else its head with a line saying how much was cut. */
export function capDiff(diff: string): string {
  if (diff.length <= REVIEW_DIFF_CAP) return diff;
  return diff.slice(0, REVIEW_DIFF_CAP) + `\n[... ${diff.length - REVIEW_DIFF_CAP} more characters of diff were cut; review what is here and say so in the summary ...]\n`;
}

/**
 * Run a review as the policy describes it. A `command` is run with the
 * request on stdin; otherwise the API is called with `model` under the
 * key in `env.ANTHROPIC_API_KEY`, and no key is a ReviewUnavailableError.
 */
export async function runReview(spec: ReviewSpec, request: ReviewRequest, opts: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<ReviewResult> {
  const env = opts.env ?? process.env;
  if (spec.command) return reviewViaCommand(spec.command, request, opts.cwd, env);
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ReviewUnavailableError(`Review "${request.name}" needs ANTHROPIC_API_KEY to call the model (or a "command" in the policy that reviews another way).`);
  return reviewViaApi(spec.model ?? DEFAULT_REVIEW_MODEL, request, apiKey);
}

/** Ask the model for a review, as structured output. No fallback model: the record names the reviewer, so it must be the one asked for. */
export async function reviewViaApi(model: string, request: ReviewRequest, apiKey: string): Promise<ReviewResult> {
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  let message: Anthropic.Message;
  try {
    message = await client.messages
      .stream({
        model,
        max_tokens: 8192,
        system: request.instructions,
        messages: [{ role: "user", content: reviewUserMessage(request) }],
        output_config: { format: { type: "json_schema", schema: REVIEW_SCHEMA as unknown as Record<string, unknown> } },
      })
      .finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new ReviewError("The API rejected ANTHROPIC_API_KEY.");
    if (err instanceof Anthropic.APIError) throw new ReviewError(`The API answered ${err.status ?? "with an error"}: ${err.message}`);
    throw err;
  }
  if (message.stop_reason === "refusal") throw new ReviewError(`${message.model} declined to review this change (the API reported a refusal).`);
  if (message.stop_reason === "max_tokens") throw new ReviewError(`${message.model} ran out of output before finishing the review.`);
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  return parseReviewResult(text, message.model);
}

function reviewUserMessage(request: ReviewRequest): string {
  return `Review "${request.name}".\n\nTask the author was given:\n${request.task}\n\nDiff:\n\`\`\`diff\n${capDiff(request.diff)}\n\`\`\``;
}

/** Run a reviewer command with the request on stdin; it answers with a ReviewResult as JSON on stdout. */
export function reviewViaCommand(command: string, request: ReviewRequest, cwd: string, env: NodeJS.ProcessEnv): Promise<ReviewResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: { ...env, GRAFT_REVIEW: request.name }, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", (e) => reject(new ReviewError(`The reviewer command could not start: ${e.message}`)));
    child.on("close", (code) => {
      const stderr = Buffer.concat(err).toString("utf8").trim();
      if (code !== 0) return reject(new ReviewError(`The reviewer command exited ${code}${stderr ? `: ${stderr.split("\n").slice(-5).join("\n")}` : ""}`));
      try {
        resolve(parseReviewResult(Buffer.concat(out).toString("utf8"), "command"));
      } catch (e) {
        reject(e);
      }
    });
    child.stdin.on("error", () => {}); // a command that reads nothing closes its stdin early; the exit code says what it did
    child.stdin.end(JSON.stringify({ ...request, diff: capDiff(request.diff) }));
  });
}

/**
 * A reviewer's answer as a ReviewResult: the verdict is request-changes
 * exactly when a blocker was found, whatever the answer said, so a record's
 * verdict always agrees with its findings.
 */
export function parseReviewResult(text: string, fallbackModel: string): ReviewResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ReviewError(`The reviewer did not answer with JSON: ${text.trim().slice(0, 200) || "(empty)"}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ReviewError("The reviewer's answer is not a JSON object.");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.findings)) throw new ReviewError('The reviewer\'s answer has no "findings" list.');
  const findings: ReviewFinding[] = r.findings.map((f, i) => {
    const o = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const severity = o.severity;
    if (severity !== "blocker" && severity !== "warning" && severity !== "nit") throw new ReviewError(`Finding ${i + 1} has severity ${JSON.stringify(severity)}; expected blocker, warning or nit.`);
    if (typeof o.text !== "string" || !o.text.trim()) throw new ReviewError(`Finding ${i + 1} has no text.`);
    return {
      severity,
      ...(typeof o.file === "string" && o.file ? { file: o.file } : {}),
      ...(Number.isInteger(o.line) && (o.line as number) > 0 ? { line: o.line as number } : {}),
      text: o.text.trim(),
    };
  });
  const model = typeof r.model === "string" && r.model.trim() ? r.model.trim() : fallbackModel;
  return {
    model,
    verdict: findings.some((f) => f.severity === "blocker") ? "request-changes" : "approve",
    summary: typeof r.summary === "string" ? r.summary.trim() : "",
    findings,
  };
}

/**
 * Why a review by `model` does not count as independent of `author`, or null
 * when it does. A human author needs no check; an agent's model must be
 * recorded and differ (a dated id counts as the same model as its alias).
 */
export function sameModelReason(author: ChangeAuthor, model: string): string | null {
  if (author.kind !== "agent") return null;
  if (!author.model) return `the author is an agent whose model is not recorded, so a review by ${model} cannot be shown to be independent (set GRAFT_AUTHOR_MODEL, or let the capture hook record it)`;
  const a = author.model.trim().toLowerCase();
  const b = model.trim().toLowerCase();
  if (a === b || a.startsWith(b) || b.startsWith(a)) return `the reviewer ran on ${model}, the model that wrote the change`;
  return null;
}

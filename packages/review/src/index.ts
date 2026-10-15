import { createServer, type Server } from "node:http";
import { Graft, type LogEntry } from "@fourshore/graft-core";
import { parseDiff } from "./diff.js";
import { renderChange, renderQueue, type QueueItem } from "./html.js";
import { RISK_ORDER, triage, type Triage } from "./triage.js";

export { parseDiff } from "./diff.js";
export type { DiffFile, DiffHunk, DiffLine } from "./diff.js";
export { groupFile, judgeEvidence, triage, RISK_ORDER } from "./triage.js";
export type { EvidenceVerdict, FileGroup, Risk, Triage } from "./triage.js";

export interface ReviewOptions {
  /** Repository to review. Defaults to the current directory. */
  repo?: string;
  /** How many commits the queue shows. */
  limit?: number;
  /** Include commits without a Graft record. Default true, so unrecorded work is visible. */
  includeUnrecorded?: boolean;
}

export interface ReviewedChange {
  entry: LogEntry;
  triage: Triage;
}

/** Everything the pages need, usable without the HTTP server (tests, other UIs). */
export class Review {
  readonly graft: Graft;
  constructor(private readonly opts: ReviewOptions = {}) {
    this.graft = new Graft(opts.repo ?? process.cwd());
  }

  async repoName(): Promise<string> {
    return this.graft.git.topLevel();
  }

  async queue(): Promise<ReviewedChange[]> {
    const entries = await this.graft.log({
      limit: this.opts.limit ?? 50,
      onlyGraft: this.opts.includeUnrecorded === false,
    });
    const items = await Promise.all(entries.map((e) => this.triageEntry(e)));
    return items.sort(
      (a, b) =>
        RISK_ORDER.indexOf(a.triage.risk) - RISK_ORDER.indexOf(b.triage.risk) ||
        Date.parse(b.entry.authoredAt) - Date.parse(a.entry.authoredAt),
    );
  }

  async change(ref: string): Promise<ReviewedChange | null> {
    const entry = await this.graft.show(ref);
    return entry ? this.triageEntry(entry) : null;
  }

  private async triageEntry(entry: LogEntry): Promise<ReviewedChange> {
    const files = parseDiff(await this.graft.diff(entry.commit));
    return { entry, triage: triage(entry.record, files) };
  }
}

/** A local HTTP server serving the review pages. Call .listen() yourself. */
export function createReviewServer(opts: ReviewOptions = {}): Server {
  const review = new Review(opts);
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      const repo = await review.repoName();
      if (url.pathname === "/") {
        const items = await review.queue();
        return html(res, 200, renderQueue(repo, items as QueueItem[]));
      }
      if (url.pathname === "/api/changes") {
        return json(res, 200, await review.queue());
      }
      const page = /^\/change\/([^/]+)$/.exec(url.pathname);
      if (page) {
        const found = await review.change(decodeURIComponent(page[1]));
        if (!found) return html(res, 404, "<h1>Not found</h1>");
        return html(res, 200, renderChange(repo, found.entry, found.triage));
      }
      const api = /^\/api\/change\/([^/]+)$/.exec(url.pathname);
      if (api) {
        const found = await review.change(decodeURIComponent(api[1]));
        return found ? json(res, 200, found) : json(res, 404, { error: "not found" });
      }
      html(res, 404, "<h1>Not found</h1>");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      html(res, 500, `<pre>${msg.replace(/</g, "&lt;")}</pre>`);
    }
  });
}

function html(res: import("node:http").ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

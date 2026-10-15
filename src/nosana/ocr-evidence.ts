// Turns a finished Nosana job into one evidence record for the daily OCR benchmark.
// Pure functions: no network, no clock, so they are unit-tested.
import type { DeploymentJobDetail } from "./deployments.ts";

export interface OcrEvidence {
  jobId: string;
  node: string | null;
  timeStart: number | null;
  timeEnd: number | null;
  wallSeconds: number | null;
  /** Nosana's job status string, or null if the API returned none. */
  jobStatus: string | null;
  /** "result" when OCR_DAILY_RESULT was found, "failed" for OCR_DAILY_FAILED, "no-result" otherwise (infrastructure failure or still running). */
  outcome: "result" | "failed" | "no-result";
  /** Why there is no result, from the operation errors, when the API gave one. */
  infrastructureError: string | null;
  summary: unknown | null;
}

const TAGS = [
  { tag: "OCR_DAILY_RESULT ", outcome: "result" as const },
  { tag: "OCR_DAILY_FAILED ", outcome: "failed" as const },
];

export function extractOcrSummary(detail: DeploymentJobDetail): { outcome: OcrEvidence["outcome"]; summary: unknown | null } {
  for (const op of detail.jobResult?.opStates ?? []) {
    for (const entry of op.logs ?? []) {
      const line = entry.log.trim();
      for (const { tag, outcome } of TAGS) {
        if (!line.startsWith(tag)) continue;
        try {
          return { outcome, summary: JSON.parse(line.slice(tag.length)) };
        } catch {
          // A truncated or corrupted log line must not be reported as a result.
        }
      }
    }
  }
  return { outcome: "no-result", summary: null };
}

function firstOperationError(detail: DeploymentJobDetail): string | null {
  for (const op of detail.jobResult?.opStates ?? []) {
    for (const err of op.errors ?? []) {
      const message = (err as { message?: unknown })?.message;
      if (typeof message === "string") return message.slice(0, 300);
    }
  }
  return null;
}

export function buildOcrEvidence(jobId: string, detail: DeploymentJobDetail): OcrEvidence {
  const { outcome, summary } = extractOcrSummary(detail);
  // The API reports 0 (not null) for a time that has not happened yet, e.g. timeEnd of a running job.
  const start = detail.timeStart ? detail.timeStart : null;
  const end = detail.timeEnd ? detail.timeEnd : null;
  return {
    jobId,
    node: detail.node ?? null,
    timeStart: start,
    timeEnd: end,
    wallSeconds: start !== null && end !== null ? end - start : null,
    jobStatus: detail.jobResult?.status ?? null,
    outcome,
    infrastructureError: outcome === "no-result" ? firstOperationError(detail) : null,
    summary,
  };
}

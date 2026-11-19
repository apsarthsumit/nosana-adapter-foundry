// Turns a finished Nosana job into one evidence record for the daily OCR benchmark.
// Pure functions: no network, no clock, so they are unit-tested.
import type { DeploymentJobDetail } from "./deployments.ts";
import { OCR_MODELS, OCR_OPERATION_ID, OCR_PAGE_COUNT, OCR_SOURCES } from "./ocr-contract.ts";

export interface OcrEvidence {
  schemaVersion: "ocr-evidence@1";
  executionMode: "nosana-live";
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
  validationError: string | null;
  summary: unknown | null;
}

const TAGS = [
  { tag: "OCR_DAILY_RESULT ", outcome: "result" as const },
  { tag: "OCR_DAILY_FAILED ", outcome: "failed" as const },
];

const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);
const score = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/** Shape and workload-identity checks, not a proof of OCR correctness or an honest host. */
export function validateOcrSummary(summary: unknown): string | null {
  if (!object(summary)) return "summary is not an object";
  if (typeof summary.gpu !== "string" || !summary.gpu.trim() || /mock|simulation|local/i.test(summary.gpu)) return "runtime GPU is missing or simulated";
  if (summary.executionMode !== undefined && summary.executionMode !== "nosana-live") return "runtime is not live";
  if (!Number.isFinite(Date.parse(summary.utc_start)) || !Number.isFinite(summary.total_seconds) || summary.total_seconds <= 0) return "runtime timing is invalid";
  if (!Array.isArray(summary.sources) || JSON.stringify(summary.sources) !== JSON.stringify(OCR_SOURCES)) return "benchmark sources do not match";
  if (!Array.isArray(summary.results) || summary.results.length !== OCR_MODELS.length) return "expected both benchmark models";
  const expectedPages = [
    ...Array.from({ length: 8 }, (_, i) => `attention-p${i + 1}`),
    ...Array.from({ length: 8 }, (_, i) => `gpt3-p${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `resnet-p${i + 1}`),
  ];
  for (const expected of OCR_MODELS) {
    const matches = summary.results.filter((r: unknown) => object(r) && r.model === expected.model);
    if (matches.length !== 1) return "model is missing or duplicated";
    const result = matches[0];
    if (result.revision !== expected.revision || result.error !== undefined) return "model revision or execution is invalid";
    if (result.pages !== OCR_PAGE_COUNT || !Array.isArray(result.per_page) || result.per_page.length !== OCR_PAGE_COUNT) return "page count does not match";
    if (![result.mean_f1_all, result.mean_f1_clean, result.mean_f1_degraded].every(score)) return "model scores are invalid";
    if (!result.per_page.every((p: unknown, i: number) => object(p) && p.doc === expectedPages[i] && p.degraded === (i % 2 === 1) && score(p.f1) && Number.isSafeInteger(p.tokens) && p.tokens >= 0)) return "per-page results are invalid";
    const mean = result.per_page.reduce((n: number, p: any) => n + p.f1, 0) / OCR_PAGE_COUNT;
    if (Math.abs(mean - result.mean_f1_all) > 0.0002) return "aggregate score contradicts page scores";
  }
  return null;
}

export function extractOcrSummary(detail: DeploymentJobDetail): { outcome: OcrEvidence["outcome"]; summary: unknown | null; validationError: string | null } {
  const ops = (detail.jobResult?.opStates ?? []).filter((op) => op.operationId === OCR_OPERATION_ID);
  const jobFailed = /failed|error/i.test(detail.jobResult?.status ?? "") || (detail.jobResult?.opStates ?? []).some((op) => /failed|error/i.test(op.status) || (op.exitCode != null && op.exitCode !== 0));
  let summary: unknown | null = null;
  let validationError: string | null = null;
  let resultCount = 0;
  let explicitFailure = false;
  for (const op of ops) {
    for (const entry of op.logs ?? []) {
      const line = entry.log.trim();
      for (const { tag, outcome } of TAGS) {
        if (!line.startsWith(tag)) continue;
        try {
          const parsed: unknown = JSON.parse(line.slice(tag.length));
          if (outcome === "failed") explicitFailure = true;
          else resultCount++;
          summary = parsed;
        } catch {
          validationError = "truncated or malformed benchmark JSON";
        }
      }
    }
  }
  if (jobFailed || explicitFailure) return { outcome: "failed", summary, validationError: "job or benchmark operation failed" };
  const terminal = detail.jobResult?.status === "success" && ops.length === 1 && ops[0].status === "success" && ops[0].exitCode === 0 && Number.isSafeInteger(detail.timeStart) && Number.isSafeInteger(detail.timeEnd) && detail.timeStart! > 0 && detail.timeEnd! > detail.timeStart!;
  if (!terminal) return { outcome: "no-result", summary, validationError: "successful terminal job and operation not established" };
  if (resultCount !== 1) validationError ??= "expected exactly one benchmark result";
  validationError ??= validateOcrSummary(summary);
  return { outcome: validationError ? "failed" : "result", summary, validationError };
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

function benchmarkFailure(summary: unknown): string | null {
  if (!object(summary) || !Array.isArray(summary.results)) return null;
  const failed = summary.results.find((r: unknown) => object(r) && typeof r.error === "string");
  return failed ? `${failed.error}: ${failed.detail ?? "no details"}`.slice(0, 300) : null;
}

export function buildOcrEvidence(jobId: string, detail: DeploymentJobDetail): OcrEvidence {
  let { outcome, summary, validationError } = extractOcrSummary(detail);
  if (outcome === "result" && (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(jobId) || typeof detail.node !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(detail.node))) {
    outcome = "failed";
    validationError = "live job or node identity is invalid";
  }
  // The API reports 0 (not null) for a time that has not happened yet, e.g. timeEnd of a running job.
  const start = detail.timeStart ? detail.timeStart : null;
  const end = detail.timeEnd ? detail.timeEnd : null;
  return {
    schemaVersion: "ocr-evidence@1",
    executionMode: "nosana-live",
    jobId,
    node: detail.node ?? null,
    timeStart: start,
    timeEnd: end,
    wallSeconds: start !== null && end !== null && end >= start ? end - start : null,
    jobStatus: detail.jobResult?.status ?? null,
    outcome,
    infrastructureError: outcome !== "result" ? firstOperationError(detail) ?? benchmarkFailure(summary) : null,
    validationError,
    summary,
  };
}

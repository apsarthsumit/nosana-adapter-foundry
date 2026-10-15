// Daily document-OCR benchmark workload: two pinned OCR models served with vLLM on a
// Nosana GPU, scored on a pinned page set. The Python lives in
// containers/ocr-benchmark/bench.py and is shipped inside the job definition as base64,
// so the job needs no registry or repo access. The result comes back in the job logs
// as one `OCR_DAILY_RESULT {json}` line (or `OCR_DAILY_FAILED {json}`).
//
// What this is: our own recurring GPU workload with a checkable output. What it is not:
// customer traffic. Scores are word-F1 against each PDF's text layer, a proxy for OCR
// quality.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const OCR_IMAGE = "docker.io/vllm/vllm-openai:v0.10.2"; // on the 3090 market's pre-pulled image list (checked 2026-10-15)
export const OCR_OP_ID = "ocr-daily-benchmark";
export const OCR_SCRIPT_PATH = resolve(import.meta.dirname, "../../containers/ocr-benchmark/bench.py");
/** Hard cap inside the container so a hung model server cannot burn the whole job timeout. */
export const OCR_SCRIPT_TIMEOUT_SECONDS = 2400;
const MIN_CREDIT_TIMEOUT_MINUTES = 50;
// Measured 2026-10-15: a deployment created with timeout 40 never received a node in 3 of 3
// tries, while the same job at timeout 70 was assigned in ~30 s. Causality is unproven, so
// stay at or above 60 to be safe.
const MIN_SAFE_TIMEOUT_MINUTES = 60;

export function readOcrScript(): string {
  return readFileSync(OCR_SCRIPT_PATH, "utf8");
}

export function buildOcrShell(script: string = readOcrScript()): string {
  const b64 = Buffer.from(script, "utf8").toString("base64");
  return [
    "pip install -q pymupdf pillow requests 2>&1 | tail -2",
    `echo ${b64} | base64 -d > /tmp/bench.py`,
    `timeout ${OCR_SCRIPT_TIMEOUT_SECONDS} python3 /tmp/bench.py`,
    "rc=$?",
    'echo "EXIT_CODE $rc"',
    "exit $rc",
  ].join("\n");
}

export interface OcrBodyInput {
  name: string;
  market: string;
  timeoutMinutes: number;
  /** Cron expression for a repeating, exit-when-done deployment. Omit for a single run. */
  schedule?: string;
}

export function buildOcrDeploymentBody(input: OcrBodyInput) {
  if (input.timeoutMinutes < MIN_CREDIT_TIMEOUT_MINUTES) throw new Error(`timeoutMinutes must be at least ${MIN_CREDIT_TIMEOUT_MINUTES} for credit-paid jobs`);
  if (input.timeoutMinutes < MIN_SAFE_TIMEOUT_MINUTES) throw new Error(`timeoutMinutes must be at least ${MIN_SAFE_TIMEOUT_MINUTES}: shorter deployments went unassigned in testing`);
  const scheduled = input.schedule !== undefined;
  return {
    name: input.name,
    market: input.market,
    replicas: 1,
    timeout: input.timeoutMinutes,
    confidential: false, // logs must be readable through the API; nothing in this job is secret
    strategy: scheduled ? ("SCHEDULED" as const) : ("SIMPLE" as const),
    ...(scheduled ? { schedule: input.schedule } : {}),
    job_definition: {
      version: "0.1",
      type: "container",
      meta: { trigger: "deployment-manager", system_requirements: { vram_total_mb: 16384 } },
      ops: [
        {
          type: "container/run",
          id: OCR_OP_ID,
          args: { image: OCR_IMAGE, gpu: true, entrypoint: "/bin/bash", cmd: ["-c", buildOcrShell()] },
        },
      ],
    },
  };
}

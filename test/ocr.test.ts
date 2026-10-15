import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { lintSecrets } from "../src/security/secret-lint.ts";
import { OCR_IMAGE, OCR_SCRIPT_PATH, buildOcrDeploymentBody, buildOcrShell } from "../src/nosana/ocr-workload.ts";
import { buildOcrEvidence, extractOcrSummary } from "../src/nosana/ocr-evidence.ts";
import type { DeploymentJobDetail } from "../src/nosana/deployments.ts";

const MARKET = "CA5pMpqkYFKtme7K31pNB1s62X2SdhEv1nN9RdxKCpuQ";
const NODE = "AHaqjDsBpEEoGw1MWAqhDaBuWvBqzAv9iW8vxtrqQKH3";

function detail(logs: string[], extra: Partial<DeploymentJobDetail> = {}): DeploymentJobDetail {
  return { node: NODE, timeStart: 1000, timeEnd: 1660, jobResult: { status: "success", opStates: [{ operationId: "ocr-daily-benchmark", status: "success", exitCode: 0, logs: logs.map((log) => ({ log })) }] }, ...extra };
}

test("OCR deployment body is a public, scheduled GPU job that passes secret lint", () => {
  const body = buildOcrDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 60, schedule: "10 5 * * *" });
  assert.deepEqual(lintSecrets(body.job_definition), []);
  assert.equal(body.strategy, "SCHEDULED");
  assert.equal(body.schedule, "10 5 * * *");
  assert.equal(body.confidential, false);
  const args = body.job_definition.ops[0].args;
  assert.equal(args.gpu, true);
  assert.equal(args.image, OCR_IMAGE);
  assert.equal(args.entrypoint, "/bin/bash");
  assert.equal(buildOcrDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 60 }).strategy, "SIMPLE");
});

test("the base64 payload in the job decodes to exactly containers/ocr-benchmark/bench.py", () => {
  const shell = buildOcrShell();
  const b64 = /echo ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/bench\.py/.exec(shell)?.[1];
  assert.ok(b64, "payload not found in shell");
  assert.equal(Buffer.from(b64, "base64").toString("utf8"), readFileSync(OCR_SCRIPT_PATH, "utf8"));
  assert.match(shell, /exit \$rc/); // the container must propagate the script's exit code
});

test("timeouts below the credit minimum or the observed-safe minimum are rejected", () => {
  assert.throws(() => buildOcrDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 30 }), /at least 50/);
  assert.throws(() => buildOcrDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 55 }), /at least 60/);
});

test("bench.py keeps its inputs pinned (versioned PDFs, 40-hex model revisions)", () => {
  const py = readFileSync(OCR_SCRIPT_PATH, "utf8");
  for (const m of py.matchAll(/https:\/\/arxiv\.org\/pdf\/[0-9.]+(v\d+)?"/g)) assert.ok(m[1], `unversioned arXiv URL: ${m[0]}`);
  const revisions = [...py.matchAll(/"([0-9a-f]{40})"/g)];
  assert.equal(revisions.length, 2);
});

test("extractOcrSummary reads the result line and ignores noise", () => {
  const summary = { gpu: "NVIDIA GeForce RTX 3090, 24576 MiB", results: [{ model: "m", mean_f1_all: 0.84 }] };
  const out = extractOcrSummary(detail(["vllm: starting", `OCR_DAILY_RESULT ${JSON.stringify(summary)}`, "EXIT_CODE 0"]));
  assert.equal(out.outcome, "result");
  assert.deepEqual(out.summary, summary);
});

test("a failed benchmark is reported as failed, and a truncated line is never reported as a result", () => {
  assert.equal(extractOcrSummary(detail([`OCR_DAILY_FAILED ${JSON.stringify({ results: [{ error: "server did not start" }] })}`])).outcome, "failed");
  const truncated = extractOcrSummary(detail(['OCR_DAILY_RESULT {"gpu": "NVIDIA GeF']));
  assert.equal(truncated.outcome, "no-result");
  assert.equal(truncated.summary, null);
  assert.equal(extractOcrSummary({ node: null }).outcome, "no-result");
});

test("a running job (timeEnd 0) has no wall time instead of a negative one", () => {
  const running = buildOcrEvidence("J0", { node: NODE, timeStart: 1792098352, timeEnd: 0, jobResult: null });
  assert.equal(running.wallSeconds, null);
  assert.equal(running.timeEnd, null);
  assert.equal(running.outcome, "no-result");
});

test("buildOcrEvidence computes wall time and surfaces a node-side error when there is no result", () => {
  const ok = buildOcrEvidence("J1", detail([`OCR_DAILY_RESULT ${JSON.stringify({ results: [] })}`]));
  assert.equal(ok.wallSeconds, 660);
  assert.equal(ok.node, NODE);
  assert.equal(ok.infrastructureError, null);

  const bad = buildOcrEvidence("J2", {
    node: NODE, timeStart: 10, timeEnd: 700,
    jobResult: { status: "failed", opStates: [{ operationId: "ocr-daily-benchmark", status: "failed", exitCode: 2, logs: [], errors: [{ event: "operation-error", message: "docker.io/vllm/vllm-openai:v0.10.2: image not known" }] }] },
  });
  assert.equal(bad.outcome, "no-result");
  assert.equal(bad.infrastructureError, "docker.io/vllm/vllm-openai:v0.10.2: image not known");
  assert.equal(bad.jobStatus, "failed");
  assert.deepEqual(lintSecrets(bad), []);
});

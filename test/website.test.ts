import test from "node:test";
import assert from "node:assert/strict";
import { evidenceRows } from "../website/app.js";
import { buildSummary } from "../scripts/build-website-data.mjs";

test("evidenceRows renders live runs, results and node-side failures as plain strings", () => {
  const rows = evidenceRows({
    gate1Live: [{ jobId: "7oVsEvTfEM99", completedAt: "2026-10-14T15:11:51.000Z", wallClockSeconds: 35, bytes: 10485760, hashMatch: true, gatePassed: true }],
    inferenceLive: [{ jobId: "76j4XwpmdVa2", model: "Qwen/Qwen2.5-0.5B-Instruct", gpu: "NVIDIA GeForce RTX 3090", submittedAt: "2026-10-14T16:02:31.279Z" }],
    ocrDaily: { runs: [
      { jobId: "9D7daDMe4ThvDXEf", startedAt: "2026-10-15T21:05:53Z", outcome: "result", wallSeconds: 394, gpu: "RTX 3090", f1Ocr15b: 0.8353, f1Ocr3b: 0.8486, infrastructureError: null },
      { jobId: "AAAAAAAAAAAAAAAA", startedAt: "2026-10-16T05:10:00Z", outcome: "no-result", wallSeconds: 12, gpu: null, f1Ocr15b: null, f1Ocr3b: null, infrastructureError: "image not known" },
    ] },
  });
  assert.equal(rows.length, 4);
  assert.match(rows[0].result, /10,485,760 bytes, SHA-256 match/);
  assert.equal(rows[0].when, "2026-10-14 15:11");
  assert.match(rows[2].result, /1\.5B F1 0\.8353, 3B F1 0\.8486/);
  assert.match(rows[3].result, /no result: image not known/);
  assert.ok(rows.every((r) => typeof r.run === "string" && typeof r.when === "string" && typeof r.result === "string"));
});

test("a hash mismatch is displayed as a mismatch, never as a match", () => {
  const [row] = evidenceRows({ gate1Live: [{ jobId: "x".repeat(12), completedAt: "2026-10-14T15:11:51.000Z", wallClockSeconds: 1, bytes: 1, hashMatch: false, gatePassed: false }] });
  assert.match(row.result, /MISMATCH/);
});

test("the evidence summary is built from real files and counts match the repository", async () => {
  const s = await buildSummary();
  assert.ok(s.testCount >= 50);
  assert.ok(s.gate1Live.length >= 2 && s.gate1Live.every((g) => g.hashMatch === true && g.gatePassed === true));
  assert.equal(s.ocrDaily.total, s.ocrDaily.results + s.ocrDaily.benchmarkFailed + s.ocrDaily.noResult);
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { validateInferenceArtifacts } from "../src/nosana/inference-result.ts";
import { writeDeterministicArtifact } from "../src/generator/deterministic-artifact.ts";
import { sha256File } from "../src/hashing/sha256.ts";
import { lintSecrets } from "../src/security/secret-lint.ts";
import { DeploymentsClient, type FetchLike } from "../src/nosana/deployments.ts";
import { GATE1_SEED, buildDeploymentBody, pythonGenerateSnippet } from "../src/nosana/gate1-workload.ts";
import { buildLiveEvidence, type ChainJob } from "../src/nosana/live-evidence.ts";

const SIZE = 10 * 1024 * 1024;
const JOB = "4XeB5wfhEPicUG2ZusKDhmUupntAqrfN2t51b4GGoCgx";
const MARKET = "CA5pMpqkYFKtme7K31pNB1s62X2SdhEv1nN9RdxKCpuQ";
const NODE = "AHaqjDsBpEEoGw1MWAqhDaBuWvBqzAv9iW8vxtrqQKH3";
const CID = "QmcZfr5rLX2Yy35a1LR1N57vR2b85eTW59SThG5NGXtHTt";
const HASH = "fbcaa745503907007d6e8aedd88694ff3575d37e2466eef9fcf4805c9d87ba66";

test("the Python in-container generator is byte-identical to the TypeScript generator", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "py-parity-"));
  try {
    const tsPath = resolve(dir, "ts.bin");
    const pyPath = resolve(dir, "py.bin");
    await writeDeterministicArtifact(tsPath, { seed: GATE1_SEED, sizeBytes: SIZE });
    execFileSync("python3", ["-I", "-c", pythonGenerateSnippet(GATE1_SEED, SIZE, pyPath)]);
    const [ts, py] = await Promise.all([sha256File(tsPath), sha256File(pyPath)]);
    assert.equal(py, ts);
    assert.equal(ts, HASH);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deployment body passes secret lint, embeds the expected digest and rejects short timeouts", () => {
  const body = buildDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 60, expectedSha256: HASH });
  assert.deepEqual(lintSecrets(body.job_definition), []);
  assert.ok(body.job_definition.ops[0].args.cmd[3].includes(HASH));
  assert.equal(body.job_definition.ops[0].args.gpu, true);
  assert.throws(() => buildDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 10, expectedSha256: HASH }), /at least 50/);
  for (const timeoutMinutes of [NaN, Infinity, 60.5]) assert.throws(() => buildDeploymentBody({ name: "n", market: MARKET, timeoutMinutes, expectedSha256: HASH }), /finite integer/);
});

test("DeploymentsClient sends the bearer key, and surfaces HTTP errors without leaking the key", async () => {
  const seen: Array<{ url: string; auth?: string }> = [];
  const fakeFetch: FetchLike = async (url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    seen.push({ url, auth: init?.headers?.Authorization });
    return { ok: !url.endsWith("/bad"), status: url.endsWith("/bad") ? 401 : 200, json: async () => ({ jobs: [] }), arrayBuffer: async () => new ArrayBuffer(0) };
  };
  const client = new DeploymentsClient("secret-key-value", fakeFetch, "https://example.test/api");
  assert.deepEqual(await client.jobs("D1"), []);
  assert.equal(seen[0].url, "https://example.test/api/deployments/D1/jobs");
  assert.equal(seen[0].auth, "Bearer secret-key-value");
  await assert.rejects(() => (client as any).request("GET", "/bad"), (e: Error) => /401/.test(e.message) && !e.message.includes("secret-key-value"));
  assert.throws(() => new DeploymentsClient("", fakeFetch), /NOSANA_API_KEY/);
  await client.fetchEndpointFile("https://node.test", "/result.json");
  assert.equal(seen.at(-1)?.auth, undefined);
});

test("scheduled start failures attempt cleanup and identify a deployment when cleanup also fails", async () => {
  for (const [startFails, stopFails] of [[false, false], [true, false], [true, true]]) {
    const calls: string[] = [];
    const client = new DeploymentsClient("test-key", async (url) => {
      calls.push(url);
      const ok = !(url.endsWith("/start") && startFails) && !(url.endsWith("/stop") && stopFails);
      return { ok, status: ok ? 200 : 503, json: async () => url.endsWith("/create") ? { id: "D1" } : { status: "ok" }, arrayBuffer: async () => new ArrayBuffer(0) };
    }, "https://example.test");
    if (startFails) await assert.rejects(client.createAndStart({}), stopFails ? /automatic stop failed.*D1/ : /503/);
    else assert.equal((await client.createAndStart({})).deployment.id, "D1");
    assert.equal(calls.some((url) => url.endsWith("/stop")), startFails);
  }
});

const chain: ChainJob = { state: "COMPLETED", market: MARKET, node: NODE, ipfsResult: CID, timeStart: 1791990281, timeEnd: 1791990330, priceRaw: 90 };
const base = {
  jobId: JOB, jobDefinitionSha256: HASH, submittedAt: new Date(1791990270_000), chain,
  chainFetchedAt: new Date(1791990400_000), verifiedAt: new Date(1791990401_000),
  expectedSha256: HASH, expectedBytes: SIZE, verifierVersion: "test",
};

test("matching retrieved artifact with consistent chain state yields gatePassed", () => {
  const e = buildLiveEvidence({ ...base, retrieved: { sha256: HASH, bytes: SIZE } });
  assert.equal(e.gatePassed, true);
  assert.equal(e.failureReason, null);
  assert.equal(e.costNos, (49 * 90) / 1e6);
});

test("a wrong digest, a wrong size, or no retrieval never passes and gets a specific reason", () => {
  const wrongHash = buildLiveEvidence({ ...base, retrieved: { sha256: "0".repeat(64), bytes: SIZE } });
  assert.equal(wrongHash.gatePassed, false);
  assert.equal(wrongHash.failureReason, "artifact_hash_mismatch");
  const wrongSize = buildLiveEvidence({ ...base, retrieved: { sha256: HASH, bytes: SIZE - 1 } });
  assert.equal(wrongSize.failureReason, "artifact_size_mismatch");
  const none = buildLiveEvidence({ ...base, retrieved: null });
  assert.equal(none.gatePassed, false);
  assert.equal(none.failureReason, "retrieval_error");
});

test("a chain state other than COMPLETED never passes", () => {
  const e = buildLiveEvidence({ ...base, chain: { ...chain, state: "STOPPED" }, retrieved: { sha256: HASH, bytes: SIZE } });
  assert.equal(e.gatePassed, false);
});

import { buildInferenceDeploymentBody, buildInferenceScript, buildInferenceShell, INFERENCE_FAILURE_MARKER, INFERENCE_MODEL_REVISION } from "../src/nosana/inference-workload.ts";

test("inference workload: script compiles, pins the model revision, and the job passes secret lint", () => {
  const script = buildInferenceScript();
  execFileSync("python3", ["-I", "-c", `import sys; compile(sys.stdin.read(), "inference", "exec")`], { input: script });
  assert.ok(script.includes(INFERENCE_MODEL_REVISION));
  assert.ok(script.includes("do_sample=False"));
  const body = buildInferenceDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 60 });
  assert.deepEqual(lintSecrets(body.job_definition), []);
  assert.throws(() => buildInferenceDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 5 }), /at least 50/);
  for (const timeoutMinutes of [NaN, Infinity, 60.5]) assert.throws(() => buildInferenceDeploymentBody({ name: "n", market: MARKET, timeoutMinutes }), /finite integer/);
});

test("scheduled inference body is a public, exit-when-done cron deployment; default stays confidential and served", () => {
  const sched = buildInferenceDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 60, schedule: "0 6 * * *" });
  assert.equal(sched.strategy, "SCHEDULED");
  assert.equal((sched as any).schedule, "0 6 * * *");
  assert.equal(sched.confidential, false);
  assert.ok(!("expose" in sched.job_definition.ops[0].args));
  assert.ok(!sched.job_definition.ops[0].args.cmd[1].includes("http.server"));
  assert.deepEqual(lintSecrets(sched.job_definition), []);
  const plain = buildInferenceDeploymentBody({ name: "n", market: MARKET, timeoutMinutes: 60 });
  assert.equal(plain.strategy, "SIMPLE");
  assert.equal(plain.confidential, true);
  assert.equal(plain.job_definition.ops[0].args.expose, 8000);
});

test("scheduled inference preserves dependency and model failure exit codes", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "inference-shell-"));
  try {
    for (const [pipCode, modelCode, expected] of [[12, 0, 12], [0, 17, 17], [0, 0, 0]]) {
      const stubs = `python3(){ if [ "$1" = "-m" ]; then return ${pipCode}; fi; echo MODEL_RAN; return ${modelCode}; }; curl(){ return 0; }; nvidia-smi(){ return 0; };\n`;
      const run = spawnSync("bash", ["-c", stubs + buildInferenceShell({ serve: false, outputDir: dir })], { encoding: "utf8", timeout: 5000 });
      assert.equal(run.status, expected, run.stderr);
      if (expected) assert.ok(run.stdout.includes(INFERENCE_FAILURE_MARKER));
      if (pipCode) assert.doesNotMatch(run.stdout, /MODEL_RAN/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("inference artifacts reject wrong model identity, missing prompts and malformed runtime metadata", () => {
  const saved = JSON.parse(readFileSync(new URL("../evidence/inference-live-2026-10-14T16-02-31.279Z.json", import.meta.url), "utf8"));
  const fixture = () => ({ manifest: structuredClone(saved.containerReported), result: { model: saved.model, revision: saved.modelRevision, decoding: "greedy", results: structuredClone(saved.results) } });
  const good = fixture();
  assert.doesNotThrow(() => validateInferenceArtifacts(good.manifest, good.result));
  const changes = [
    (f: any) => { f.result.model = "different-model"; },
    (f: any) => { f.result.revision = "0".repeat(40); },
    (f: any) => { f.result.results.pop(); },
    (f: any) => { f.result.results[0].prompt = "different-prompt"; },
    (f: any) => { f.result.results[0].completion = ""; },
    (f: any) => { f.manifest.resultSha256 = "invalid"; },
    (f: any) => { f.manifest.resultBytes = -1; },
    (f: any) => { f.manifest.seconds = Infinity; },
    (f: any) => { f.manifest.gpu = "mock GPU"; },
  ];
  for (const change of changes) { const f = fixture(); change(f); assert.throws(() => validateInferenceArtifacts(f.manifest, f.result)); }
});

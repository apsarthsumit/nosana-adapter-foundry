// Runs the real-model inference workload on Nosana and writes an inference record.
// Spends Nosana credits: requires `--live` and GATE1_LIVE=1. Always stops the deployment.
import { mkdir, writeFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@nosana/sdk";
import { canonicalJsonSha256, sha256File } from "../hashing/sha256.ts";
import { lintSecrets } from "../security/secret-lint.ts";
import { DeploymentsClient, type FetchLike } from "../nosana/deployments.ts";
import { buildInferenceDeploymentBody, INFERENCE_MODEL, INFERENCE_MODEL_REVISION, type InferenceManifest } from "../nosana/inference-workload.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
if (!process.argv.includes("--live") || process.env.GATE1_LIVE !== "1") throw new Error("refusing to spend Nosana credits: pass --live and set GATE1_LIVE=1");
const root = resolve(import.meta.dirname, "../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const market = process.env.NOSANA_MARKET;
if (!market) throw new Error("NOSANA_MARKET is required");
const waitSeconds = Number(process.env.INFERENCE_WAIT_SECONDS ?? 900);
const nodeWaitSeconds = Number(process.env.INFERENCE_NODE_WAIT_SECONDS ?? 1500);

async function main(): Promise<void> {
  const api = new DeploymentsClient(process.env.NOSANA_API_KEY ?? "", fetch as unknown as FetchLike);
  const dir = await mkdtemp(resolve(tmpdir(), "nosana-inference-"));
  let deploymentId: string | null = null;
  try {
    const body = buildInferenceDeploymentBody({ name: `inference-${Date.now()}`, market: market as string, timeoutMinutes: Number(process.env.GATE1_TIMEOUT_MINUTES ?? 60) });
    const findings = lintSecrets(body.job_definition);
    if (findings.length) throw new Error(`secret lint failed: ${JSON.stringify(findings)}`);

    const submittedAt = new Date();
    const dep = await api.create(body);
    deploymentId = dep.id;
    await api.start(dep.id);
    console.error(`deployment ${dep.id} started`);
    const url = dep.endpoints[0]?.url;
    if (!url) throw new Error("no exposed endpoint");

    let manifestBytes: Uint8Array | null = null;
    // Two clocks: up to nodeWaitSeconds for a node to pick the job up (first log line),
    // then waitSeconds of actual container time.
    const nodeDeadline = Date.now() + nodeWaitSeconds * 1000;
    let deadline = nodeDeadline;
    let started = false;
    let seenLog = "";
    while (!manifestBytes && Date.now() < deadline) {
      await sleep(15_000);
      const logBytes = await api.fetchEndpointFile(url, "/log.txt").catch(() => null);
      const log = logBytes ? new TextDecoder().decode(logBytes) : "";
      if (log.length > seenLog.length) console.error(log.slice(seenLog.length).trimEnd());
      seenLog = log;
      if (!started && log.length > 0) {
        started = true;
        deadline = Date.now() + waitSeconds * 1000;
      }
      manifestBytes = await api.fetchEndpointFile(url, "/manifest.json").catch(() => null);
      if (!manifestBytes && /PIP_FAILED|PYTHON_FAILED/.test(log)) throw new Error("container reported a failure (see log above)");
    }
    if (!manifestBytes) throw new Error(`no manifest served within ${waitSeconds}s (container log lines seen: ${seenLog.split("\n").length})`);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as InferenceManifest;
    const resultBytes = await api.fetchEndpointFile(url, "/result.json");
    if (!resultBytes) throw new Error("result.json not retrievable");
    const resultPath = resolve(dir, "result.json");
    await writeFile(resultPath, resultBytes);
    const localSha = await sha256File(resultPath);

    const jobId = (await api.jobs(dep.id))[0]?.job;
    if (!jobId) throw new Error("deployment reports no job");
    await api.stop(dep.id);
    deploymentId = null;

    const sdk = new Client("mainnet", undefined, { solana: { priority_fee: 0 } });
    let chain: any;
    for (const stop = Date.now() + 180_000; Date.now() < stop; await sleep(5_000)) {
      chain = await sdk.jobs.get(jobId);
      if (chain.state === "COMPLETED" && chain.ipfsResult) break;
    }
    if (chain?.state !== "COMPLETED") throw new Error(`job not COMPLETED on-chain (state ${chain?.state})`);

    const integrityOk = localSha === manifest.resultSha256 && resultBytes.length === manifest.resultBytes;
    const result = JSON.parse(new TextDecoder().decode(resultBytes));
    const record = {
      kind: "nosana-inference-run",
      executionMode: "nosana-live",
      model: INFERENCE_MODEL,
      modelRevision: INFERENCE_MODEL_REVISION,
      nosanaJobId: jobId,
      market: String(chain.market),
      node: String(chain.node),
      chainState: chain.state,
      resultReference: chain.ipfsResult,
      jobDefinitionSha256: canonicalJsonSha256(body.job_definition),
      submittedAt: submittedAt.toISOString(),
      chainTimeStart: Number(chain.timeStart),
      chainTimeEnd: Number(chain.timeEnd),
      costNos: ((Number(chain.timeEnd) - Number(chain.timeStart)) * Number(chain.price)) / 1e6,
      containerReported: manifest,
      retrievedResultSha256: localSha,
      retrievedResultBytes: resultBytes.length,
      transferIntegrityOk: integrityOk,
      claim: "Transfer integrity only: downloaded bytes match the digest the container reported. Output correctness and cross-hardware determinism are not claimed.",
      results: result.results,
    };
    await mkdir(resolve(root, "evidence"), { recursive: true });
    const path = resolve(root, `evidence/inference-live-${submittedAt.toISOString().replaceAll(":", "-")}.json`);
    await writeFile(path, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ path, nosanaJobId: jobId, gpu: manifest.gpu, transferIntegrityOk: integrityOk, costNos: record.costNos }, null, 2));
    if (!integrityOk) process.exitCode = 1;
  } finally {
    if (deploymentId) await api.stop(deploymentId).catch((e) => console.error(`WARNING: failed to stop ${deploymentId}: ${e}`));
    await rm(dir, { recursive: true, force: true });
  }
}
await main();
process.exit(process.exitCode ?? 0);

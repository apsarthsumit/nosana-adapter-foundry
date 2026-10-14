// Runs Gate 1 against the real Nosana network: creates a deployment, waits for the
// node to serve the generated artifact, downloads it, hashes it locally, reads the
// job's on-chain state independently via @nosana/sdk, and writes validated evidence.
//
// This spends Nosana credits, so it refuses to run without BOTH `--live` and
// GATE1_LIVE=1. The deployment is always stopped in `finally`.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@nosana/sdk";
import { canonicalJsonSha256, sha256File } from "../hashing/sha256.ts";
import { writeDeterministicArtifact } from "../generator/deterministic-artifact.ts";
import { lintSecrets } from "../security/secret-lint.ts";
import { DeploymentsClient, type FetchLike } from "../nosana/deployments.ts";
import { GATE1_ARTIFACT_SIZE_BYTES, GATE1_SEED, buildDeploymentBody } from "../nosana/gate1-workload.ts";
import { buildLiveEvidence, type ChainJob } from "../nosana/live-evidence.ts";

const VERIFIER_VERSION = "gate1-live-runner@1.0.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!process.argv.includes("--live") || process.env.GATE1_LIVE !== "1") {
  throw new Error("refusing to spend Nosana credits: pass --live and set GATE1_LIVE=1");
}
const root = resolve(import.meta.dirname, "../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const apiKey = process.env.NOSANA_API_KEY ?? "";
const market = process.env.NOSANA_MARKET;
if (!market) throw new Error("NOSANA_MARKET is required");
const timeoutMinutes = Number(process.env.GATE1_TIMEOUT_MINUTES ?? 60);
const waitSeconds = Number(process.env.GATE1_WAIT_SECONDS ?? 600);

async function readChainJob(jobId: string): Promise<ChainJob> {
  const sdk = new Client("mainnet", undefined, { solana: { priority_fee: 0 } });
  const deadline = Date.now() + 180_000;
  for (;;) {
    const job = (await sdk.jobs.get(jobId)) as unknown as {
      state: string; market: string; node: string; ipfsResult: string | null;
      timeStart: number; timeEnd: number; price: unknown;
    };
    if (job.state === "COMPLETED" && job.timeEnd > 0 && job.ipfsResult) {
      return {
        state: job.state, market: String(job.market), node: String(job.node), ipfsResult: job.ipfsResult,
        timeStart: Number(job.timeStart), timeEnd: Number(job.timeEnd), priceRaw: Number(job.price),
      };
    }
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not reach COMPLETED with a result on-chain (state ${job.state})`);
    await sleep(5_000);
  }
}

async function main(): Promise<void> {
  const api = new DeploymentsClient(apiKey, fetch as unknown as FetchLike);
  const runDir = await mkdtemp(resolve(tmpdir(), "nosana-gate1-live-"));
  let deploymentId: string | null = null;
  try {
    // The expected digest comes from the repo's own TypeScript generator, never from the node.
    const expectedPath = resolve(runDir, "expected.bin");
    const params = { seed: GATE1_SEED, sizeBytes: GATE1_ARTIFACT_SIZE_BYTES };
    await writeDeterministicArtifact(expectedPath, params);
    const expectedSha256 = await sha256File(expectedPath);

    const body = buildDeploymentBody({ name: `gate1-live-${Date.now()}`, market: market as string, timeoutMinutes, expectedSha256 });
    const findings = lintSecrets(body.job_definition);
    if (findings.length) throw new Error(`public job definition failed secret lint: ${JSON.stringify(findings)}`);

    const balance = await api.creditBalance();
    console.error(`credits: assigned ${balance.assignedCredits}, reserved ${balance.reservedCredits}, settled ${balance.settledCredits}`);

    const submittedAt = new Date();
    const deployment = await api.create(body);
    deploymentId = deployment.id;
    await api.start(deployment.id);
    console.error(`deployment ${deployment.id} started`);

    const endpointUrl = deployment.endpoints[0]?.url;
    if (!endpointUrl) throw new Error("deployment has no exposed endpoint");

    let bytes: Uint8Array | null = null;
    const deadline = Date.now() + waitSeconds * 1000;
    while (!bytes && Date.now() < deadline) {
      await sleep(10_000);
      bytes = await api.fetchEndpointFile(endpointUrl, "/artifact.bin").catch(() => null);
    }
    if (!bytes) throw new Error(`no artifact served within ${waitSeconds}s (no_host_available or job_timeout)`);

    const retrievedPath = resolve(runDir, "retrieved.bin");
    await writeFile(retrievedPath, bytes);
    const retrieved = { sha256: await sha256File(retrievedPath), bytes: bytes.length };

    const jobs = await api.jobs(deployment.id);
    const jobId = jobs[0]?.job;
    if (!jobId) throw new Error("deployment reports no job");

    // Stop first so the job reaches a terminal state, then read the chain.
    await api.stop(deployment.id);
    deploymentId = null;
    const chain = await readChainJob(jobId);

    const evidence = buildLiveEvidence({
      jobId,
      jobDefinitionSha256: canonicalJsonSha256(body.job_definition),
      submittedAt,
      chain,
      chainFetchedAt: new Date(),
      verifiedAt: new Date(),
      expectedSha256,
      expectedBytes: params.sizeBytes,
      retrieved,
      verifierVersion: VERIFIER_VERSION,
    });

    await mkdir(resolve(root, "evidence"), { recursive: true });
    const evidencePath = resolve(root, `evidence/gate1-live-${submittedAt.toISOString().replaceAll(":", "-")}.json`);
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
    console.log(JSON.stringify({ evidencePath, nosanaJobId: jobId, hashMatch: evidence.hashMatch, gatePassed: evidence.gatePassed, costNos: evidence.costNos }, null, 2));
    if (!evidence.gatePassed) process.exitCode = 1;
  } finally {
    if (deploymentId) await api.stop(deploymentId).catch((e) => console.error(`WARNING: failed to stop ${deploymentId}: ${e}`));
    await rm(runDir, { recursive: true, force: true });
  }
}

await main();
process.exit(process.exitCode ?? 0);

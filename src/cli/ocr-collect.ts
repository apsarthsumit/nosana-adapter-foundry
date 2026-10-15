// Reads every job of an OCR deployment through the Nosana API and writes one evidence
// file per job to evidence/ocr-daily/<jobId>.json. Read-only against Nosana: it spends
// no credits. A job that has not produced a result yet (still running, or failed in
// infrastructure) is re-checked on the next run; a job with a result is never rewritten.
//   node src/cli/ocr-collect.ts --deployment <deploymentId>
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { lintSecrets } from "../security/secret-lint.ts";
import { DeploymentsClient, type FetchLike } from "../nosana/deployments.ts";
import { buildOcrEvidence, type OcrEvidence } from "../nosana/ocr-evidence.ts";

const root = resolve(import.meta.dirname, "../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const argv = process.argv.slice(2);
const i = argv.indexOf("--deployment");
const deployment = i >= 0 ? argv[i + 1] : undefined;
if (!deployment) throw new Error("--deployment <id> is required");

const api = new DeploymentsClient(process.env.NOSANA_API_KEY ?? "", fetch as unknown as FetchLike);
const dir = resolve(root, "evidence/ocr-daily");
await mkdir(dir, { recursive: true });

let written = 0;
for (const job of await api.jobs(deployment)) {
  const path = resolve(dir, `${job.job}.json`);
  if (existsSync(path)) {
    const prior = JSON.parse(await readFile(path, "utf8")) as OcrEvidence;
    if (prior.outcome !== "no-result") continue;
  }
  const evidence = buildOcrEvidence(job.job, await api.job(deployment, job.job));
  const findings = lintSecrets(evidence);
  if (findings.length) throw new Error(`secret lint failed for ${job.job}: ${JSON.stringify(findings)}`);
  await writeFile(path, JSON.stringify({ deployment, ...evidence }, null, 1) + "\n");
  written++;
  console.log(JSON.stringify({ job: job.job, outcome: evidence.outcome, wallSeconds: evidence.wallSeconds, error: evidence.infrastructureError }));
}
console.log(JSON.stringify({ deployment, written }));

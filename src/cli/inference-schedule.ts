// Creates (and starts) a repeating inference deployment on Nosana. Each firing runs
// the same pinned-model workload and exits; the job logs carry the result and its
// digest. This spends credits unattended until the deployment is stopped, so it
// requires `--live`, GATE1_LIVE=1 and an explicit --cron. Stop it with:
//   node src/cli/inference-schedule.ts --stop <deploymentId>
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { lintSecrets } from "../security/secret-lint.ts";
import { DeploymentsClient, type FetchLike } from "../nosana/deployments.ts";
import { buildInferenceDeploymentBody } from "../nosana/inference-workload.ts";

const root = resolve(import.meta.dirname, "../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const api = new DeploymentsClient(process.env.NOSANA_API_KEY ?? "", fetch as unknown as FetchLike);
const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

const stopId = arg("--stop");
if (stopId) {
  console.log(JSON.stringify(await api.stop(stopId)));
} else {
  if (!argv.includes("--live") || process.env.GATE1_LIVE !== "1") throw new Error("refusing to spend Nosana credits: pass --live and set GATE1_LIVE=1");
  const cron = arg("--cron");
  if (!cron) throw new Error("--cron \"<m h dom mon dow>\" is required");
  const market = process.env.NOSANA_MARKET;
  if (!market) throw new Error("NOSANA_MARKET is required");
  const body = buildInferenceDeploymentBody({ name: `inference-scheduled-${Date.now()}`, market, timeoutMinutes: 60, schedule: cron });
  const findings = lintSecrets(body.job_definition);
  if (findings.length) throw new Error(`secret lint failed: ${JSON.stringify(findings)}`);
  const dep = await api.create(body);
  console.log(JSON.stringify({ created: dep.id, status: dep.status, cron }));
  console.log(JSON.stringify(await api.start(dep.id)));
}

// Rebuild the eight historical OCR records from archived public explorer logs.
// Offline only: does not use credentials, submit jobs or fetch the network.
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { buildOcrEvidence } from "../src/nosana/ocr-evidence.ts";
import { OCR_OPERATION_ID } from "../src/nosana/ocr-contract.ts";
import { lintSecrets } from "../src/security/secret-lint.ts";

const root = path.resolve(import.meta.dirname, "..");
export function recoverOcrRecord(source) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(source.jobId) || source.source.url !== `https://explore.nosana.com/jobs/${source.jobId}`) throw new Error("invalid archived job identity");
  if (!["success", "failed"].includes(source.status) || !Array.isArray(source.logs)) throw new Error("archive lacks a terminal status or logs");
  const timeStart = Date.parse(source.startedAt) / 1000;
  if (!Number.isSafeInteger(timeStart) || !Number.isSafeInteger(source.wallSeconds) || source.wallSeconds < 1) throw new Error("invalid archived timing");
  const detail = {
    node: source.node,
    timeStart,
    timeEnd: timeStart + source.wallSeconds,
    jobResult: {
      status: source.status,
      opStates: [{ operationId: OCR_OPERATION_ID, status: source.status, exitCode: source.exitCode, logs: source.logs.map((log) => ({ log })), errors: source.errors.map((message) => ({ message })) }],
    },
  };
  return {
    deployment: source.deployment,
    ...buildOcrEvidence(source.jobId, detail),
    provenance: {
      ...source.source,
      method: "archived-public-explorer-result-logs",
      runtimeLogSha256: createHash("sha256").update(source.logs.join("\n")).digest("hex"),
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  let written = 0;
  for (const name of (await readdir(path.join(root, "evidence/ocr-sources"))).filter((n) => n.endsWith(".json")).sort()) {
    const source = JSON.parse(await readFile(path.join(root, "evidence/ocr-sources", name), "utf8"));
    const record = recoverOcrRecord(source);
    if (lintSecrets(record).length) throw new Error(`secret lint failed for archived record ${source.jobId}`);
    const text = JSON.stringify(record, null, 1) + "\n";
    const target = path.join(root, "evidence/ocr-daily", name);
    // Always read an existing record before replacing it. Source archives retain
    // the original logs; this deterministic projection can be rebuilt or checked.
    const previous = await readFile(target, "utf8").catch((e) => { if (e.code === "ENOENT") return null; throw e; });
    if (previous !== null && JSON.parse(previous).jobId !== source.jobId) throw new Error(`refusing to replace mismatched job ${name}`);
    if (check) { if (previous !== text) throw new Error(`historical OCR evidence is stale: ${name}`); }
    else if (previous !== text) { await writeFile(target, text); written++; }
  }
  console.log(check ? "historical OCR evidence matches archived public results" : `updated ${written} historical OCR evidence records`);
}

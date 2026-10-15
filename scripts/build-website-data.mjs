// Builds website/evidence-summary.json from the evidence files and the test sources, so
// the public page never carries a hand-typed count. The Vercel project uses website/ as
// its root and cannot read ../evidence, so the summary is generated here and committed.
//   node scripts/build-website-data.mjs          write the file
//   node scripts/build-website-data.mjs --check  fail if the committed file is stale
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const iso = (unixSeconds) => new Date(unixSeconds * 1000).toISOString().replace(/\.\d+Z$/, "Z");

export async function buildSummary() {
  const evidenceDir = path.join(root, "evidence");
  const names = (await readdir(evidenceDir)).sort();

  const gate1Live = [];
  const inferenceLive = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const d = await readJson(path.join(evidenceDir, name));
    if (name.startsWith("gate1-live-") && d.executionMode === "nosana-live") {
      gate1Live.push({ jobId: d.nosanaJobId, completedAt: d.completedAt, wallClockSeconds: Math.round(d.wallClockSeconds), bytes: d.artifactActualBytes, hashMatch: d.hashMatch, gatePassed: d.gatePassed });
    }
    if (name.startsWith("inference-live-") && d.executionMode === "nosana-live") {
      inferenceLive.push({ jobId: d.nosanaJobId, model: d.model, gpu: d.containerReported?.gpu ?? null, submittedAt: d.submittedAt });
    }
  }

  const ocrDir = path.join(evidenceDir, "ocr-daily");
  let ocrFiles = [];
  try { ocrFiles = (await readdir(ocrDir)).filter((n) => n.endsWith(".json")); } catch { /* no runs yet */ }
  const runs = [];
  for (const name of ocrFiles) {
    const e = await readJson(path.join(ocrDir, name));
    const results = e.summary?.results ?? [];
    const f1 = (model) => results.find((r) => r.model === model)?.mean_f1_all ?? null;
    runs.push({
      jobId: e.jobId,
      startedAt: e.timeStart ? iso(e.timeStart) : null,
      outcome: e.outcome,
      wallSeconds: e.wallSeconds,
      gpu: e.summary?.gpu ?? null,
      f1Ocr15b: f1("nanonets/Nanonets-OCR2-1.5B-exp"),
      f1Ocr3b: f1("nanonets/Nanonets-OCR2-3B"),
      infrastructureError: e.infrastructureError ?? null,
    });
  }
  runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)) || a.jobId.localeCompare(b.jobId));
  const count = (outcome) => runs.filter((r) => r.outcome === outcome).length;

  let testCount = 0;
  for (const name of await readdir(path.join(root, "test"))) {
    if (name.endsWith(".test.ts")) testCount += (await readFile(path.join(root, "test", name), "utf8")).split("\n").filter((l) => l.startsWith("test(")).length;
  }

  gate1Live.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  inferenceLive.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt));
  return {
    testCount,
    gate1Live,
    inferenceLive,
    ocrDaily: { total: runs.length, results: count("result"), benchmarkFailed: count("failed"), noResult: count("no-result"), runs },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const target = path.join(root, "website", "evidence-summary.json");
  const text = JSON.stringify(await buildSummary(), null, 1) + "\n";
  if (process.argv.includes("--check")) {
    const current = await readFile(target, "utf8").catch(() => "");
    if (current !== text) { console.error("website/evidence-summary.json is stale: run `npm run website:data`"); process.exit(1); }
    console.log("website evidence summary is current");
  } else {
    await writeFile(target, text);
    console.log(`wrote ${path.relative(root, target)}`);
  }
}

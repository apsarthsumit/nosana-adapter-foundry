import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { buildSummary } from "./build-website-data.mjs";

const root = process.cwd();
const website = path.join(root, "website");
const publicFiles = ["index.html", "styles.css", "premium.css", "app.js", "vercel.json"];
const contents = new Map();

for (const file of publicFiles) contents.set(file, await readFile(path.join(website, file), "utf8"));

const html = contents.get("index.html");
const ids = [...html.matchAll(/\sid=["']([^"']+)["']/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicateIds.length) throw new Error(`duplicate HTML ids: ${[...new Set(duplicateIds)].join(", ")}`);

const anchors = [...html.matchAll(/\shref=["']#([^"']+)["']/g)].map((match) => match[1]);
const missingAnchors = anchors.filter((anchor) => !ids.includes(anchor));
if (missingAnchors.length) throw new Error(`unresolved internal anchors: ${[...new Set(missingAnchors)].join(", ")}`);

const localAssets = [...html.matchAll(/\s(?:src|href)=["']([^"']+)["']/g)]
  .map((match) => match[1])
  .filter((value) => !/^(?:https?:|mailto:|#)/.test(value));
for (const asset of localAssets) await access(path.join(website, asset));

const combined = [...contents.entries()].map(([name, content]) => `\n${name}\n${content}`).join("");
for (const [name, pattern] of [
  ["local absolute path", /\/Users\//],
  ["PEM private key header", /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/],
  ["em dash", /—/],
]) {
  if (pattern.test(combined)) throw new Error(`public website contains forbidden ${name}`);
}

if (!html.includes('id="team"')) throw new Error("team section is missing");
if (!html.includes("All usage so far is our own, not customer traffic")) throw new Error("self-run usage disclosure is missing");

// Numbers on the page must come from the repository, not from memory.
const summary = await buildSummary();
const committed = await readFile(path.join(website, "evidence-summary.json"), "utf8").catch(() => "");
if (committed !== JSON.stringify(summary, null, 1) + "\n") throw new Error("website/evidence-summary.json is stale: run `npm run website:data`");
for (const needle of [`${summary.testCount} AUTOMATED TESTS PASSING`, `<strong>${summary.testCount}</strong>`, `${summary.testCount} tests passed`]) {
  if (!html.includes(needle)) throw new Error(`website test count is out of date, expected: ${needle}`);
}
if (/35\/35|35 tests/.test(html)) throw new Error("website still carries the old 35-test claim");
if (/PENDING|coming soon/i.test(html.replace(/reveal-pending/g, ""))) throw new Error("website still says something is pending or coming soon");
if (!contents.get("app.js").includes("nosanaJobExecuted: false")) throw new Error("browser evidence safety flag is missing");
if (!contents.get("premium.css").includes("prefers-reduced-motion:reduce")) throw new Error("reduced-motion handling is missing");

console.log(`website check passed: ${ids.length} unique ids, ${anchors.length} internal links, ${localAssets.length} local assets`);

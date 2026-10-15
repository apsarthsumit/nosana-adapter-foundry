const GITHUB_URL = "https://github.com/apsarthsumit/nosana-adapter-foundry";

// --- Pure logic -------------------------------------------------------
// Exported so the same functions this page runs in the browser can be
// imported and tested from Node (see test/inspector.test.ts at the project
// root). Nothing below this point touches the DOM.

export async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const buffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

export function buildEvidence({ digest, byteLength }) {
  const evidence = {
    demonstration: "browser-sha256",
    executionMode: "local-browser",
    inputBytes: byteLength,
    digestAlgorithm: "sha256",
    digest,
    nosanaJobExecuted: false
  };
  if (byteLength === 0) evidence.note = "empty payload: this is the real SHA-256 of zero bytes, not a project artifact hash";
  return evidence;
}

/**
 * Turns website/evidence-summary.json into display rows. Pure so it can be tested from Node.
 * Each row: { run, when, result }. Strings only; the page renders them with textContent.
 */
export function evidenceRows(summary) {
  const short = (id) => `${id.slice(0, 8)}...`;
  const gpuName = (gpu) => (gpu ? gpu.split(",")[0] : "unknown GPU");
  const day = (iso) => (iso ? iso.replace("T", " ").replace(/:\d\d(\.\d+)?Z$/, "") : "unknown");
  const rows = [];
  for (const g of summary.gate1Live ?? []) {
    rows.push({ run: `Gate 1 round trip ${short(g.jobId)}`, when: day(g.completedAt), result: `${g.bytes.toLocaleString("en-US")} bytes, SHA-256 ${g.hashMatch ? "match" : "MISMATCH"}, ${g.wallClockSeconds} s` });
  }
  for (const i of summary.inferenceLive ?? []) {
    rows.push({ run: `Inference ${short(i.jobId)}`, when: day(i.submittedAt), result: `${i.model} on ${gpuName(i.gpu)}` });
  }
  for (const r of summary.ocrDaily?.runs ?? []) {
    const detail = r.outcome === "result"
      ? `OCR 1.5B F1 ${r.f1Ocr15b}, 3B F1 ${r.f1Ocr3b}, ${r.wallSeconds} s on ${gpuName(r.gpu)}`
      : r.outcome === "failed" ? "benchmark failed (see evidence file)"
      : `no result: ${r.infrastructureError ?? "job not finished or no logs returned"}`;
    rows.push({ run: `OCR benchmark ${short(r.jobId)}`, when: day(r.startedAt), result: detail });
  }
  return rows;
}

// --- Browser wiring -----------------------------------------------------
// Everything below only runs when a DOM is present, so this file stays
// importable from Node for the pure-logic test above.

if (typeof document !== "undefined") {
  activateGithubLinks();
  wireInspector();
  wireScrollReveal();
  renderEvidence();
}

async function renderEvidence() {
  const body = document.querySelector("#evidence-rows");
  if (!body) return;
  try {
    const res = await fetch("evidence-summary.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const summary = await res.json();
    const gate1 = document.querySelector("#stat-gate1");
    const ocr = document.querySelector("#stat-ocr");
    if (gate1) gate1.textContent = String(summary.gate1Live.filter((g) => g.hashMatch).length);
    if (ocr) ocr.textContent = String(summary.ocrDaily.total);
    body.replaceChildren(...evidenceRows(summary).map((row) => {
      const tr = document.createElement("tr");
      for (const text of [row.run, row.when, row.result]) {
        const td = document.createElement("td");
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }));
  } catch {
    body.replaceChildren(Object.assign(document.createElement("tr"), { innerHTML: "<td colspan='3'>Evidence summary unavailable. The records are in the evidence folder of the repository.</td>" }));
  }
}

function activateGithubLinks() {
  if (!GITHUB_URL) return;
  document.querySelectorAll("[data-github]").forEach((link) => {
    link.href = GITHUB_URL;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.classList.remove("disabled");
    link.removeAttribute("aria-disabled");
    const arrow = link.querySelector(".link-arrow");
    if (arrow) arrow.textContent = "↗";
    const labelEl = link.querySelector(".link-label");
    if (labelEl && link.dataset.liveLabel) labelEl.textContent = link.dataset.liveLabel;
  });
}

function wireInspector() {
  const workloadInput = document.querySelector("#workload-input");
  const computedHash = document.querySelector("#computed-hash");
  const evidencePreview = document.querySelector("#evidence-preview");
  const copyHash = document.querySelector("#copy-hash");
  const presets = document.querySelectorAll("[data-payload]");
  if (!workloadInput || !computedHash || !evidencePreview) return;

  async function updateInspector() {
    const payload = workloadInput.value;
    const byteLength = utf8ByteLength(payload);
    const digest = await sha256(payload);
    computedHash.textContent = digest;
    evidencePreview.textContent = JSON.stringify(buildEvidence({ digest, byteLength }), null, 2);
  }

  // Sequence guard: only the most recently scheduled update is allowed to
  // write to the DOM, so fast typing never leaves a stale hash on screen.
  let updateSequence = 0;
  workloadInput.addEventListener("input", () => {
    const sequence = ++updateSequence;
    window.setTimeout(() => {
      if (sequence === updateSequence) updateInspector();
    }, 80);
  });

  presets.forEach((preset) => {
    preset.addEventListener("click", () => {
      workloadInput.value = preset.dataset.payload;
      presets.forEach((item) => item.classList.toggle("active", item === preset));
      updateInspector();
    });
  });

  const copyHashDefaultLabel = copyHash?.getAttribute("aria-label") ?? "Copy computed SHA-256 digest";
  copyHash?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(computedHash.textContent);
      copyHash.textContent = "COPIED";
      copyHash.setAttribute("aria-label", "Copied SHA-256 digest to clipboard");
    } catch {
      copyHash.textContent = "COPY FAILED";
      copyHash.setAttribute("aria-label", "Copy to clipboard failed");
    } finally {
      window.setTimeout(() => {
        copyHash.textContent = "COPY";
        copyHash.setAttribute("aria-label", copyHashDefaultLabel);
      }, 1200);
    }
  });

  updateInspector();
}

function wireScrollReveal() {
  const targets = document.querySelectorAll("[data-reveal]");
  if (!targets.length) return;
  if (!("IntersectionObserver" in window)) {
    targets.forEach((el) => el.classList.add("is-visible"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const el = entry.target;
          el.classList.add("is-visible");
          observer.unobserve(el);
          // reveal-pending only needs to exist long enough to play the entrance
          // transition; removing it afterward restores each element's normal
          // (e.g. hover) transitions instead of permanently overriding them.
          window.setTimeout(() => el.classList.remove("reveal-pending", "is-visible"), 600);
        }
      });
    },
    { threshold: 0.2, rootMargin: "0px 0px -8% 0px" }
  );
  targets.forEach((el, index) => {
    el.classList.add("reveal-pending");
    el.style.setProperty("--reveal-delay", `${Math.min(index % 4, 3) * 60}ms`);
    observer.observe(el);
  });
}

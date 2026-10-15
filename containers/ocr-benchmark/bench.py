"""Daily document-OCR benchmark that runs inside a Nosana GPU container.

Pinned inputs (so one day's result is comparable with the next):
  * three arXiv PDFs at fixed versions, first pages of each (22 pages, half degraded)
  * two OCR models at fixed Hugging Face commits, served with vLLM
Score: word-level F1 against the PDF's own embedded text layer. That is a proxy for
OCR quality (reading order and math are not scored), not a ground-truth benchmark.

Exactly one machine-readable line is printed at the end:
  OCR_DAILY_RESULT {json}      on success for every model
  OCR_DAILY_FAILED {json}      if any model could not be served or scored
The process exits non-zero in the failed case so the Nosana job shows as failed.
"""
import base64, collections, concurrent.futures as cf, io, json, os, re, subprocess, sys, time, urllib.request

LOCAL_MOCK = os.environ.get("LOCAL_MOCK") == "1"  # offline logic check: "OCR" returns the truth text

SOURCES = [("attention", "https://arxiv.org/pdf/1706.03762v7", 8), ("gpt3", "https://arxiv.org/pdf/2005.14165v4", 8), ("resnet", "https://arxiv.org/pdf/1512.03385v1", 6)]
MODELS = [
    ("nanonets/Nanonets-OCR2-1.5B-exp", "49a96f20ac641c7b3ad811914968ea8e1ace1760"),
    ("nanonets/Nanonets-OCR2-3B", "c3886ff00bb037ce7da24988c9eafaf1fe2bed72"),
]
MAX_TOKENS = 4096
PROMPT = ("Extract the text from the above document as if you were reading it naturally. Return the tables in html format. "
          "Return the equations in LaTeX representation. If there is an image in the document and image caption is not present, "
          "add a small description of the image inside the <img></img> tag; otherwise, add the image caption inside <img></img>. "
          "Watermarks should be wrapped in brackets. Ex: <watermark>OFFICIAL COPY</watermark>. Page numbers should be wrapped in brackets. "
          "Ex: <page_number>14</page_number> or <page_number>9/22</page_number>. Prefer using ☐ and ☑ for check boxes.")


def tokens(text):
    return re.findall(r"[a-z0-9]+", text.lower())


def word_f1(truth, got):
    a, b = collections.Counter(tokens(truth)), collections.Counter(tokens(got))
    overlap = sum((a & b).values())
    if not a or not b or overlap == 0:
        return 0.0
    p, r = overlap / sum(b.values()), overlap / sum(a.values())
    return 2 * p * r / (p + r)


def build_pages():
    import fitz  # pymupdf
    from PIL import Image
    pages = []
    for name, url, n in SOURCES:
        data = None
        for attempt in range(3):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ocr-benchmark"})
                data = urllib.request.urlopen(req, timeout=120).read()
                break
            except Exception as e:
                print("fetch retry", name, attempt, repr(e)[:120], flush=True)
                time.sleep(5)
        if data is None:
            raise RuntimeError(f"could not fetch {url}")
        doc = fitz.open(stream=data, filetype="pdf")
        for i in range(min(n, len(doc))):
            page = doc[i]
            truth = page.get_text()
            if len(tokens(truth)) < 80:
                continue
            degraded = len(pages) % 2 == 1
            pix = page.get_pixmap(dpi=100 if degraded else 150)
            img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
            buf = io.BytesIO()
            if degraded:
                img = img.rotate(1.0, expand=True, fillcolor=(255, 255, 255))
                img.save(buf, "JPEG", quality=35)
                mime = "image/jpeg"
            else:
                img.save(buf, "PNG")
                mime = "image/png"
            pages.append({"doc": f"{name}-p{i + 1}", "degraded": degraded, "truth": truth, "b64": base64.b64encode(buf.getvalue()).decode(), "mime": mime})
    return pages


def ocr(model, page):
    if LOCAL_MOCK:
        return page["truth"], 0
    import requests
    body = {"model": model, "temperature": 0, "max_tokens": MAX_TOKENS, "messages": [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": f"data:{page['mime']};base64,{page['b64']}"}}, {"type": "text", "text": PROMPT}]}]}
    r = requests.post("http://127.0.0.1:8000/v1/chat/completions", json=body, timeout=600)
    r.raise_for_status()
    j = r.json()
    return j["choices"][0]["message"]["content"], j["usage"]["completion_tokens"]


def start_server(model, revision):
    import requests
    log = open("/tmp/vllm.log", "w")
    p = subprocess.Popen(["python3", "-m", "vllm.entrypoints.openai.api_server", "--model", model, "--revision", revision, "--served-model-name", model,
                          "--port", "8000", "--max-model-len", "30000", "--gpu-memory-utilization", "0.85"], stdout=log, stderr=subprocess.STDOUT)
    t0 = time.time()
    while time.time() - t0 < 900:
        if p.poll() is not None:
            return None, 0.0, open("/tmp/vllm.log").read()[-800:]
        try:
            if requests.get("http://127.0.0.1:8000/v1/models", timeout=3).ok:
                return p, time.time() - t0, ""
        except Exception:
            pass
        time.sleep(3)
    p.kill()
    return None, 0.0, "vllm did not become ready in 900 s: " + open("/tmp/vllm.log").read()[-800:]


def stop_server(p):
    if p:
        p.terminate()
        try:
            p.wait(timeout=60)
        except Exception:
            p.kill()
        time.sleep(8)


def run_model(model, revision, pages):
    p, up, err = None, 0.0, ""
    if not LOCAL_MOCK:
        for attempt in (1, 2):  # nodes fail randomly; one retry is cheap
            p, up, err = start_server(model, revision)
            if p:
                break
            print("vllm start failed, attempt", attempt, err[-300:].replace("\n", " | "), flush=True)
            time.sleep(10)
        if p is None:
            return {"model": model, "revision": revision, "error": "server did not start", "detail": err[-300:]}
    try:
        for pg in pages[:2]:
            ocr(model, pg)  # warm-up, excluded from timing
        t0 = time.time()
        with cf.ThreadPoolExecutor(8) as ex:
            outs = list(ex.map(lambda pg: ocr(model, pg), pages))
        wall = time.time() - t0
    except Exception as e:
        stop_server(p)
        return {"model": model, "revision": revision, "error": "inference failed", "detail": repr(e)[:300]}
    stop_server(p)
    res = [{"doc": pg["doc"], "degraded": pg["degraded"], "f1": round(word_f1(pg["truth"], text), 4), "tokens": ntok} for pg, (text, ntok) in zip(pages, outs)]

    def mean(xs):
        return round(sum(xs) / len(xs), 4) if xs else None
    return {"model": model, "revision": revision, "pages": len(pages), "server_start_s": round(up, 1), "batch8_wall_s": round(wall, 1),
            "pages_per_hour": round(len(pages) / wall * 3600), "mean_f1_all": mean([r["f1"] for r in res]),
            "mean_f1_clean": mean([r["f1"] for r in res if not r["degraded"]]), "mean_f1_degraded": mean([r["f1"] for r in res if r["degraded"]]),
            "runaway_pages": sum(1 for r in res if r["tokens"] >= MAX_TOKENS), "avg_completion_tokens": mean([r["tokens"] for r in res]), "per_page": res}


def main():
    t_all = time.time()
    gpu = "mock" if LOCAL_MOCK else subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
    print("GPU", gpu, flush=True)
    pages = build_pages()
    print("PAGES", len(pages), "degraded", sum(p["degraded"] for p in pages), flush=True)
    results = [run_model(m, rev, pages) for m, rev in MODELS]
    summary = {"utc_start": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t_all)), "gpu": gpu, "total_seconds": round(time.time() - t_all),
               "sources": [u for _, u, _ in SOURCES], "scoring": "word F1 vs PDF text layer (proxy)", "results": results}
    failed = [r for r in results if "error" in r]
    print(("OCR_DAILY_FAILED " if failed else "OCR_DAILY_RESULT ") + json.dumps(summary, sort_keys=True), flush=True)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

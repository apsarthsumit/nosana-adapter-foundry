# OCR reliability changes, 19 November 2026

MEASURED — `src/nosana/ocr-workload.ts` now stops setup after 300 seconds,
limits the benchmark process to 2400 seconds, fails on dependency-install or
payload-decode errors, and preserves the benchmark exit code. Its existing
60-minute deployment timeout is unchanged. These are process time limits,
not a guarantee of the amount billed by the provider.

MEASURED — Direct Python dependencies are pinned to PyMuPDF 1.26.4, Pillow
11.3.0 and requests 2.32.5. PyPI's version endpoints were checked on November 19;
all three report Python >=3.9. Full transitive locking and GPU-image compatibility
remain unverified. Future result summaries include installed package versions
and the Python version (`containers/ocr-benchmark/bench.py`). Historical logs
are retained as originally reported, without invented runtime metadata.

INFERRED — A fresh PYTHONPYCACHEPREFIX may avoid the cached-bytecode failure
seen in one historical run. It does not repair damaged source files, establish
why that failure occurred, or demonstrate better GPU startup reliability.

MEASURED — The validator now recomputes overall, clean-page and degraded-page
means from the page scores (`src/nosana/ocr-evidence.ts`). Regression tests in
`test/ocr.test.ts` reject contradictions and execute the generated shell with
stubbed failures for installation, setup timeout, decoding and benchmarking.
These tests do not install the GPU stack or exercise a remote node.

MEASURED — Docker Hub's registry returned this multi-platform manifest-list digest
for vllm/vllm-openai:v0.10.2 on November 19:
`sha256:607442e407b0fea97f8a132a78b787c121a996dd4de181fa08e8da06e71ec2db`.
The response lists Linux arm64 and amd64. This is a current registry observation,
not proof of the image used by October jobs. The job's tag is unchanged until
Nosana market support for digest references is confirmed.

## Work still requiring live validation

INFERRED — Confirm supported read-only API authentication first. After access
and credit limits are understood, validate the generated job against the chosen
market, then run one explicitly budgeted smoke test. Check installed versions,
GPU identity, terminal operation status, both models' 22-page results and all
three aggregate means. Record failures as well as successful results. Compare
billed compute with the intended cap before enabling a recurring schedule.

INFERRED — Do not enable recurring spending just to increase usage counts. A
future grant needs a useful regular workload, measured compute needs and a
credible payer. Customer willingness to pay requires external validation.

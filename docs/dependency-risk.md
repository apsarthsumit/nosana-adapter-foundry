# Dependency risk review, 19 November 2026

MEASURED — `npm audit --json` reported 69 affected package entries: 6 critical,
35 high, 20 moderate and 8 low. These are package entries, not a count of distinct
CVEs. The command returned a nonzero status because findings remain.
The counts, affected packages and full-report SHA-256 are retained in
[dependency-audit-2026-11-19.json](dependency-audit-2026-11-19.json).

MEASURED — `package.json` declares `@nosana/cli` and `@nosana/sdk` as direct
Node dependencies. The live artifact runner uses the SDK for chain state;
`src/nosana/deployments.ts` uses a separate HTTP client for deployments.
The project now has live evidence under `evidence/` and `evidence/ocr-daily/`.
The September report's statement that only simulation had run is historical.

INFERRED — The September reachability analysis cannot establish the safety of
current live execution paths. Development dependency placement also does not
make a package harmless when a live runner imports it. No finding is dismissed
here solely because it is transitive or marked development-only.

MEASURED — This review did not upgrade the CLI or SDK or change the npm lockfile.
No claim is made that the dependencies are remediated. The September report is
preserved in [dependency-risk-2026-09-11.md](dependency-risk-2026-09-11.md).

INFERRED — Before another paid run, review a supported CLI/SDK upgrade against
Nosana's current API and validate read-only chain access and deployment payloads.
A green offline test suite does not establish live API compatibility. Avoid a
forced transitive override without checking compatibility and the affected paths.

MEASURED — OCR's three directly installed Python packages are now version-pinned
in `src/nosana/ocr-workload.ts`. This npm audit does not audit Python packages or
container contents. Their transitive dependencies are not fully locked, and the
container still uses a tag because acceptance of digest references by the market
has not been verified. This is partial runtime pinning, not a reproducibility or
security certification.

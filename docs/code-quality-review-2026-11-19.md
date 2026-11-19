# Code quality review, 19 November 2026

## Corrected in this review

MEASURED — `src/nosana/inference-workload.ts` emitted INFERENCE_FAILED while
`src/cli/inference-live.ts` checked only older failure markers. Both now use
one exported marker. This corrects the mismatch; an unavailable job-served
endpoint can still prevent the runner from observing the log.

MEASURED — The inference runner previously labelled results with the configured
model without validating the downloaded payload's model, revision, decoding
mode or prompt list. `src/nosana/inference-result.ts` now validates those fields,
nonempty completions and the manifest's basic hash, size and runtime metadata
before the runner records a result. Hash matching still establishes transfer
integrity only, not model answer correctness or an honest compute host.

MEASURED — The two scheduled CLI entry points duplicated create/start behavior
without cleanup on a failed start. They now call DeploymentsClient.createAndStart.
It attempts a stop after a failed or ambiguous start and identifies the deployment
if cleanup also fails. `test/live.test.ts` exercises all three outcomes.

MEASURED — HTTP calls in `src/nosana/deployments.ts` previously had no request
timeout. API requests and endpoint downloads now receive 30-second abort signals.
The independent SDK chain-polling calls have not been bounded by this change.

MEASURED — Gate 1 and inference deployment builders now reject non-finite or
fractional timeout values, matching the OCR builder. The README now correctly
identifies OCR and scheduled inference as public deployments.

## Duplication assessment

MEASURED — An exact-text scan of src/**/*.ts, after trimming lines and excluding
blank and full-line comments, found three overlapping eight-line duplicate
windows in the scheduler setup sections. They represent one boilerplate region.
This is a text scan, not an AST comparison or a proof that all semantic
implementation duplication has been found.

INFERRED — The remaining small scheduler bootstrap duplication does not justify
an additional abstraction in this prototype. The create/start/cleanup policy was
worth centralizing because it affects unattended resource use.

MEASURED — The deterministic artifact generator exists in TypeScript and in an
embedded Python snippet for the container. `test/live.test.ts` executes both and
compares the generated artifact hashes. The separate implementations serve the
host/container language boundary; one is not an unused copy.

## Remaining limitations

MEASURED — The current dependency findings are recorded in
`docs/dependency-audit-2026-11-19.json`; they are not remediated by these fixes.
The existing API key returned HTTP 401 in the earlier read-only checks.

INFERRED — Before paid execution, restore valid API access, review dependency
remediation and compatibility, agree a spending cap, and validate one smoke run.
Before production use, also bound chain RPC calls and artifact memory usage,
validate API response shapes, and exercise cleanup failures against the real
service. Passing offline tests does not establish these properties.

INFERRED — The disclosed prototype can be described in a Build Log. It should
not be presented as production-ready, independently security-audited, fully
reproducible, or validated across compute providers.

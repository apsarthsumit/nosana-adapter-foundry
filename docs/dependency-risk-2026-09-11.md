# Dependency risk report

Produced by `npm audit --json` against the installed tree (VERIFIED_BY_COMMAND,
`npm audit`, run 2026-09-11 on `@nosana/cli@1.0.133`). No dependency was
upgraded, pinned, or auto-fixed as part of this review.

## Totals

58 advisories: 5 critical, 32 high, 13 moderate, 8 low (VERIFIED_BY_COMMAND).
**All 58 are transitive dependencies of `@nosana/cli`** - this project's own
code (`src/`, `test/`, `containers/`) has zero direct dependencies beyond
`@nosana/cli` itself and Node's standard library, so every advisory here is
"we depend on a tool that depends on vulnerable things," not "our code is
vulnerable."

## What Gate 1 actually exercises today

Two commands have been run against this tree: `nosana job validate` and the
(no-network) `--simulate` path, which touches none of `@nosana/cli`'s
dependencies at all. Neither `job post` nor `job get`/`download` has been
executed (VERIFIED_FROM_FILES: no live job evidence exists;
`evidence/*.json` all show `executionMode: "simulation"`).

## Reachability of the critical-severity findings

| Package | Reachable from... | Evidence |
|---|---|---|
| `tar` (`node_modules/@nosana/cli/node_modules/tar`) | `nosana job get --download` / `nosana job download <cid>` | Directly imported: `import tar from 'tar'` in `dist/src/cli/job/download/action.js:2`, used to `tar.extract()` whatever bytes come back from `nosana.ipfs.retrieve(ipfshash)` (same file, line 22). VERIFIED_FROM_FILES. Advisories include multiple path-traversal / arbitrary-file-write CVEs during extraction - a real risk if `--download` is ever pointed at an untrusted or wrong CID, not just a theoretical transitive listing. |
| `form-data` (`node_modules/@nosana/cli/node_modules/@nosana/sdk/node_modules/form-data`) | Every `nosana job post`, via `nosana.ipfs.pin(json_flow)` (`dist/src/cli/job/post/action.js:121`) | `form-data` is a direct dependency of `@nosana/sdk` (`node_modules/@nosana/cli/node_modules/@nosana/sdk/package.json:71`), which `post/action.js` calls into for every job submission, including the minimal safe command this review designed. VERIFIED_FROM_FILES for the dependency edge; the exact HTTP code path inside `@nosana/sdk` that uses it was not read in this pass. |
| `@vitest/coverage-v8`, `vitest` | **None found** | Both are listed only under `@nosana/cli`'s own `devDependencies` (`node_modules/@nosana/cli/package.json:53,66`), used for `@nosana/cli`'s *own* test suite. `grep -rl "vitest" node_modules/@nosana/cli/dist/` matches only `dist/package.json` (the copied manifest) - no compiled source file references it. VERIFIED_BY_COMMAND: dead weight on disk, not on any path a Gate 1 command executes. |
| `shell-quote` | Unconfirmed | Present in the dependency tree as a direct `dependencies` entry of `@nosana/cli` itself (`package.json:92`), but `grep -rl "shell-quote" node_modules/@nosana/cli/dist/src` returned no matches (VERIFIED_BY_COMMAND) - it is not directly imported by the CLI's own compiled command code. Whether an SDK-internal path reaches it was not established. |

## High-severity findings worth calling out by name

- `axios`, `undici`, `ws`, `@solana/web3.js`, `rpc-websockets`, `jayson`: all sit
  on the Solana RPC / websocket path used by `nosana.jobs.list`,
  `nosana.jobs.get`, and job-state subscriptions (`waitForJobCompletion` in
  `dist/src/services/jobs.js` uses `nosana.jobs.connection.onAccountChange`,
  which VERIFIED_FROM_FILES goes through `@solana/web3.js`/`rpc-websockets`).
  These become reachable the moment any live job is posted or polled - i.e.
  on the very first live Gate 1 attempt, independent of whether artifact
  retrieval ever gets fixed.
- `vite`: devDependency of `@nosana/cli`, same dead-weight status as `vitest`
  above (not independently re-verified against `dist/`, but same package.json
  section).

## Conclusion

Nothing in this tree is reachable through the two commands actually run so
far (`validate`, `--simulate`). The moment a real `job post` is attempted
(task 8's dry-run explicitly does not do this), the reachable surface expands
to include the Solana RPC stack (high-severity DoS/SSRF-class issues in
`axios`/`undici`/`ws`) and IPFS pinning (`form-data`, critical). If artifact
retrieval is ever made to work, `tar` extraction (critical, path-traversal
class CVEs) becomes reachable too and deserves the most scrutiny of anything
in this tree, since it operates on content fetched by CID rather than
something this project fully controls end-to-end.

No `npm audit fix` was run and no dependency version was changed, per
instructions. Upgrading `@nosana/cli` itself (a version bump, not a patch to
its transitive tree) is the only realistic remediation path for most of these,
since almost none of the vulnerable packages are direct dependencies of this
project.

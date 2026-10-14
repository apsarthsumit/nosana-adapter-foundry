# Nosana Adapter Foundry

![CI](https://github.com/satyawansinghinuk-stack/nosana-adapter-foundry/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)

Project website: https://nosana-adapter-foundry.vercel.app/

Nosana Adapter Foundry is an open prototype for turning a small dataset into a
verified, versioned training and inference workload on the Nosana GPU
network. This repository contains Gate 1: a small, self-contained check of
whether a deterministic artifact can survive a Nosana job round trip byte for
byte, with an evidence record that distinguishes a real result from a
rehearsal.

## The problem

Decentralized GPU networks remove a layer of infrastructure trust that
centralized providers normally absorb. Before a training or inference
pipeline is built on top of one, three questions need concrete answers, not
assumptions:

- Does a submitted job actually complete and return usable output.
- Can the resulting artifact be retrieved intact, with a hash to prove it.
- What does the CLI and SDK actually support today, as opposed to what the
  documentation implies.

Gate 1 exists to answer those questions for one narrow case (a small,
deterministic binary artifact) before any model training work is attempted on
top of the same infrastructure.

## Current status

**Prototype. Gate 1 has passed once on live Nosana, and one small open model has run end to end. Nothing here is a sustained workload yet.**

Two live runs on the Nosana mainnet (2026-10-14), both submitted by code in this
repository, each with a job ID that can be looked up on the Nosana explorer:

| Run | Job ID | What it proves |
|---|---|---|
| Gate 1 artifact round trip (`npm run gate1:live`) | `7oVsEvTfEM99HhtJfEWwMpCSkzSrLJzEZVWd2w8aQe2B` | A 10 MiB artifact generated on a Nosana GPU node was downloaded and its SHA-256 matched the digest computed locally by this repo's own generator; the job's on-chain state was read independently via `@nosana/sdk` |
| Real-model inference (`npm run inference:live`) | `76j4XwpmdVa25xJ5zjzskjqitpLc54u4WyL53fSitRqx` | `Qwen/Qwen2.5-0.5B-Instruct` (Apache-2.0, pinned revision) ran greedy decoding on an RTX 3090; the downloaded result file matched the digest the container reported |

Scope of those claims: **transfer integrity and a real end-to-end execution
only.** They do not show that model output is correct, and they do not claim
identical output across different hardware. Total spend so far is a few
hundredths of a credit; this is a working pipeline, not a production workload.

A simulation evidence record is still permanently marked
`"executionMode": "simulation"`, and the schema makes `"gatePassed": true`
structurally impossible outside a live, independently verified run. See
`src/evidence/job-evidence.ts`.

| Component | Status |
|---|---|
| Deterministic artifact generator | Implemented, tested locally |
| Evidence schema (simulation vs. live) | Implemented, tested locally |
| Secret linter for job definitions | Implemented, tested locally |
| Job definition | Passes `nosana job validate` |
| Live job submission (Nosana deployments API) | Implemented, run live once per workload |
| Artifact retrieval from a completed job | Works via an HTTP endpoint the job itself serves (not via the CLI; see below) |
| Independent on-chain job state | Implemented via `@nosana/sdk`, run live |
| Real-model inference adapter | One small model, run live once; no scale or reproducibility testing yet |

## What Gate 1 tests

Gate 1 generates a 10 MiB artifact from a fixed public seed, using a
deterministic SHA-256-based generator so the same seed always produces the
same bytes on any machine. In simulation mode, the artifact is written,
copied, and re-hashed locally to exercise the full generation, hashing, and
evidence pipeline. A live run would replace the local copy step with an
actual Nosana job: submit the job, wait for completion, retrieve the result,
and compare its hash against the value computed before submission.

```mermaid
flowchart LR
    A[Deterministic seed] --> B[Generate 10 MiB artifact]
    B --> C[Hash artifact locally]
    C --> D{Execution mode}
    D -->|simulation| E[Copy locally, re-hash]
    D -->|live, not yet implemented| F[Submit to Nosana, wait, retrieve]
    E --> G[Evidence record]
    F --> G[Evidence record]
    G --> H{gatePassed}
    H -->|simulation| I[Always false]
    H -->|live| J[True only with independent verification]
```

Gate 1 does not test model training, GPU correctness, confidentiality,
preemption recovery, or checkpoint durability. It tests one thing: whether a
known artifact goes in and the same artifact comes out.

## Installation and verification

Requires Node.js 22.6 or newer.

```bash
git clone https://github.com/satyawansinghinuk-stack/nosana-adapter-foundry.git
cd nosana-adapter-foundry
npm install
npm test
npm run gate1:validate-job
npm run gate1:simulate
```

`npm test` runs the unit and schema tests. `npm run gate1:validate-job`
checks the job definition against the official Nosana CLI validator.
`npm run gate1:simulate` runs the full local pipeline and writes an evidence
file to `evidence/`. None of these three commands submit a job, spend NOS or
SOL, or require a wallet.

A fourth command, `npm run gate1:live-dry-run`, prints the exact `nosana`
CLI command a live run would use and the computed cost ceiling, without
executing it. It requires market parameters as environment variables and
still does not touch the network.

## Nosana CLI blocker and how it was worked around

Reading the installed `@nosana/cli` 1.0.133 source directly (see
`docs/nosana-cli-findings.md` for exact file and line references) found that
`-o/--output` on `nosana job post` is not implemented in this version. It
throws `artifact support coming soon!` and returns immediately. The CLI's
only working artifact auto-detection path requires a job definition
convention this project does not currently have a way to satisfy without a
third-party pinning credential.

**As of this CLI version, the CLI itself has no working artifact retrieval.**
The live runs here bypass the CLI: the job's container serves its output
directory over HTTP on an exposed port through a Nosana deployment, and
`src/cli/gate1-live.ts` downloads and hashes the file. This is a working path,
but it is not confirmed to be the mechanism Nosana recommends. `docs/nosana-cli-findings.md` has
the full investigation, and `docs/dependency-risk.md` covers what `npm audit`
reports for the packages a live submission would exercise.

## Roadmap

1. **Supported live artifact round trip.** Done once (job above), via the
   endpoint workaround. Confirming Nosana's recommended egress mechanism is open.
2. **GPU inference adapter.** One small model run live once. Repeated runs,
   larger models, and reproducibility comparison across nodes are not done.
3. **Evaluation and parameter-efficient fine-tuning adapter.** Add a small
   QLoRA or comparable fine-tuning job, plus a base-model-versus-adapter
   evaluation, on top of the same verified infrastructure.
4. **Public developer release.** Package the verified pieces into a
   documented, reusable tool once the above milestones hold up under real
   use.

No dates are attached to these milestones. Each one starts only after the
previous one is verified, not assumed.

## Repository structure

```
src/
  cli/                    Entry points (simulation runner, live dry-run printer)
  generator/               Deterministic artifact generator
  hashing/                  Streaming SHA-256 and canonical JSON hashing
  evidence/                 Evidence schema and validation
  security/                 Secret linter for job definitions
  nosana/
    job-definitions/        The Gate 1 job definition
    dry-run.ts               Builds (never executes) the live Nosana command
containers/
  gate1-artifact-roundtrip/ Container image source for a live run
test/                      Unit and schema tests
docs/
  gate1-assumptions.md      What is verified, inferred, or still unknown
  nosana-cli-findings.md    Source-level investigation of the installed CLI
  dependency-risk.md        npm audit findings and their reachability
evidence/
  gate1-simulation.json     One canonical example evidence record
```

## Security guidance

Nosana job definitions are public by default. Nothing sensitive belongs in
`src/nosana/job-definitions/`, in a test fixture, or in any file tracked by
this repository:

- No wallet file, private key, or seed phrase.
- No API token, access token, or bearer credential.
- No `.env` file. Use `.env.example` as a template and keep the real `.env`
  local and untracked.

`src/security/secret-lint.ts` checks job definitions for common credential
shapes (Solana keypair arrays, base58 secret key material, JWTs, GitHub and
Hugging Face tokens, AWS access keys, bearer tokens) before a job is
submitted, and both `npm test` and `npm run gate1:simulate` exercise it. It
is a best-effort check, not a substitute for reviewing what you are about to
submit. See `SECURITY.md` for how to report a vulnerability or a leaked
credential.

## Team

- **Satyawan Singh**, Project Lead and Engineering. System architecture,
  implementation, Nosana integration, AI workload adapters, and technical
  documentation.
- **Naina**, Cybersecurity. Threat-boundary review, secret-handling review,
  public job-definition safety, dependency exposure, and evidence integrity.
- **Naveen Chirumamilla**, QA Automation. Test planning, automated regression
  coverage, acceptance-gate validation, and reproducibility testing.

## Contributing

See `CONTRIBUTING.md`. In short: read `docs/gate1-assumptions.md` first, run
the four verification commands before and after your change, never commit a
credential, and never present simulation output as a live result.

## Limitations

- Live evidence is two runs on one day. There is no sustained or repeated
  usage yet, and no cross-node reproducibility testing.
- The live jobs run Python inside stock public images
  (`nosana/pytorch-jupyter`, `pytorch/pytorch`). The Node container image in
  `containers/` and `gate1-artifact-roundtrip.job.json` are not what the live
  runner submits, and that image has not been built or published.
- Live jobs are confidential deployments, so the dashboard returns no job logs.
  The runner reads a `log.txt` the job serves itself for diagnosis.
- The first live inference attempts timed out (a 1.5B model's weights did not
  finish downloading on the node); the 0.5B model is what succeeded. Those
  attempts are not hidden: they appear in the git history of this work.
- Dependency vulnerabilities exist in `@nosana/cli`'s own dependency tree.
  None are known to be reachable through the commands this project currently
  runs (`validate`, `--simulate`); several would become reachable the moment
  a live job is posted. See `docs/dependency-risk.md`.
- This project has not been tested on Node.js 25. The Docker image pins an
  exact Node 22 version and is unaffected; the plain npm scripts have only
  been verified on Node 22.19.0.
- CI does not run `npm run gate1:validate-job`, because the installed
  Nosana CLI performs a live network call to the npm registry on every
  invocation and can fail for reasons unrelated to the job definition's own
  validity. Run that command locally before merging a change to the job
  definition.

## License

Apache License 2.0. See `LICENSE`.

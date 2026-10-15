# Contributing

Nosana Adapter Foundry is an early prototype. Gate 1 is the only verified
component so far, and it runs in simulation mode only. Contributions are
welcome, but please read this document and `docs/gate1-assumptions.md`
before opening a pull request, so your change lands in the right place.

## Getting started

Requirements: Node.js 22.6 or newer.

```bash
git clone https://github.com/apsarthsumit/nosana-adapter-foundry.git
cd nosana-adapter-foundry
npm install
npm test
npm run gate1:validate-job
npm run gate1:simulate
```

All four commands should succeed before you start making changes, and again
before you open a pull request.

## What to work on

Check `docs/nosana-cli-findings.md` first. It lists the confirmed blockers in
the installed Nosana CLI, including the artifact-egress limitation that
currently prevents Gate 1 from running live. Fixes or workarounds for that
blocker are the highest-value contribution right now.

Smaller, welcome contributions:

- additional unit tests, particularly around edge cases in
  `src/evidence/job-evidence.ts` and `src/security/secret-lint.ts`
- documentation corrections, especially anywhere a claim should be marked
  more precisely as verified, inferred, or unknown
- dependency-risk findings in `docs/dependency-risk.md` kept current as
  `@nosana/cli` is upgraded

## Rules that apply to every contribution

1. **Never commit a wallet file, private key, seed phrase, API token, or
   `.env` file.** Nosana job definitions are public by default. Nothing
   sensitive may appear in `src/nosana/job-definitions/`, in test fixtures,
   or in any file tracked by git. Run `npm run gate1:validate-job` and the
   test suite before committing; the secret linter in
   `src/security/secret-lint.ts` is exercised by both.
2. **Never claim a live Nosana result that did not happen.** Evidence
   records produced in `--simulate` mode must keep
   `executionMode: "simulation"` and `gatePassed: false`. Do not hand-edit an
   evidence file to make it look live, and do not describe simulation output
   as a live result in an issue, pull request, or commit message.
3. **Do not submit a paid or live Nosana job as part of a contribution or
   its CI run.** Live experiments are tracked separately and require a
   disposable wallet, not something a pull request should assume access to.
4. **Use `python3`, not `python`,** in any script or example that needs a
   Python interpreter.
5. **Do not perform source-code edits with blind string replacement**
   (for example, a Python script that rewrites TypeScript files by regex).
   Use a proper editor or an AST-aware tool so changes stay reviewable as a
   diff.
6. Keep the existing `package-lock.json` unless a dependency genuinely needs
   to change. Do not run a speculative `npm update`.

## Pull requests

- Keep changes focused. A pull request that fixes a bug should not also
  reformat unrelated files.
- Explain what you tested and how, including the commands above.
- If your change affects the evidence schema, job definition, or CLI
  findings, update `docs/gate1-assumptions.md` and
  `docs/nosana-cli-findings.md` in the same pull request so the documented
  assumptions stay accurate.

## Reporting a security issue

See `SECURITY.md`. Do not open a public issue for a credential leak or a
vulnerability that could be actively exploited.

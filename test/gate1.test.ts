import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  writeDeterministicArtifact,
  validateArtifactParameters,
  MAX_ARTIFACT_SIZE_BYTES,
} from "../src/generator/deterministic-artifact.ts";
import { sha256File, canonicalJsonSha256 } from "../src/hashing/sha256.ts";
import { lintSecrets } from "../src/security/secret-lint.ts";
import { validateEvidence, type JobEvidence, type IndependentJobState } from "../src/evidence/job-evidence.ts";

// VERIFIED_FROM_FILES: node_modules/@nosana/cli/dist/src/services/jobs.js exports
// EMPTY_ADDRESS = new PublicKey('11111111111111111111111111111111') - 32 base58
// characters, so it is a real, well-formed Solana address shape to use as a fixture.
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
const OTHER_ADDRESS = "22222222222222222222222222222222";
// Well-known example CIDv0 (46 chars, "Qm" + 44 base58) used purely as a format fixture -
// this is not a claim that any Gate 1 run has produced or resolved this CID.
const EXAMPLE_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

function validLiveEvidenceFixture(): JobEvidence {
  const hash = "a".repeat(64);
  const independentJobState: IndependentJobState = {
    fetchedAt: new Date(65_000).toISOString(),
    status: "COMPLETED",
    market: SYSTEM_PROGRAM_ADDRESS,
    node: SYSTEM_PROGRAM_ADDRESS,
    ipfsResult: EXAMPLE_CID,
    timeStart: 0,
    timeEnd: 60,
    priceRaw: 100000,
  };
  return {
    schemaVersion: "1.1.0",
    gateId: "gate1-artifact-roundtrip",
    executionMode: "nosana-live",
    gatePassed: true,
    nosanaJobId: SYSTEM_PROGRAM_ADDRESS,
    market: SYSTEM_PROGRAM_ADDRESS,
    node: SYSTEM_PROGRAM_ADDRESS,
    jobDefinitionSha256: hash,
    submittedAt: new Date(0).toISOString(),
    completedAt: new Date(60_000).toISOString(),
    wallClockSeconds: 60,
    costNos: 0.01,
    costUsd: 0.002,
    resultReference: EXAMPLE_CID,
    artifactExpectedSha256: hash,
    artifactActualSha256: hash,
    artifactExpectedBytes: 1024,
    artifactActualBytes: 1024,
    hashMatch: true,
    failureReason: null,
    verifiedAt: new Date(70_000).toISOString(),
    verifierVersion: "gate1-verifier@1.1.0",
    independentJobState,
  };
}

// ---------------------------------------------------------------------------
// Deterministic artifact generator
// ---------------------------------------------------------------------------

test("artifact is deterministic and exact length", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "gate1-test-"));
  try {
    const a = resolve(dir, "a.bin"), b = resolve(dir, "b.bin");
    await writeDeterministicArtifact(a, { seed: "public-test-seed", sizeBytes: 100_003 });
    await writeDeterministicArtifact(b, { seed: "public-test-seed", sizeBytes: 100_003 });
    assert.equal(await sha256File(a), await sha256File(b));
    assert.equal((await stat(a)).size, 100_003);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("different public seeds produce different hashes", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "gate1-test-"));
  try {
    const a = resolve(dir, "a.bin"), b = resolve(dir, "b.bin");
    await writeDeterministicArtifact(a, { seed: "public-seed-one", sizeBytes: 4096 });
    await writeDeterministicArtifact(b, { seed: "public-seed-two", sizeBytes: 4096 });
    assert.notEqual(await sha256File(a), await sha256File(b));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("invalid, zero and unsafe artifact sizes are rejected", () => {
  assert.throws(() => validateArtifactParameters({ seed: "public-test-seed", sizeBytes: 0 }));
  assert.throws(() => validateArtifactParameters({ seed: "public-test-seed", sizeBytes: -1 }));
  assert.throws(() => validateArtifactParameters({ seed: "public-test-seed", sizeBytes: 1.5 }));
  assert.throws(() => validateArtifactParameters({ seed: "public-test-seed", sizeBytes: NaN }));
  assert.throws(() => validateArtifactParameters({ seed: "public-test-seed", sizeBytes: Infinity }));
  assert.throws(() => validateArtifactParameters({ seed: "public-test-seed", sizeBytes: MAX_ARTIFACT_SIZE_BYTES + 1 }));
  assert.doesNotThrow(() => validateArtifactParameters({ seed: "public-test-seed", sizeBytes: MAX_ARTIFACT_SIZE_BYTES }));
});

test("does not delete a pre-existing unrelated file when the target path already exists", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "gate1-test-"));
  try {
    const target = resolve(dir, "occupied.bin");
    await writeFile(target, "unrelated content");
    await assert.rejects(
      writeDeterministicArtifact(target, { seed: "public-test-seed", sizeBytes: 1024 }),
      (error: NodeJS.ErrnoException) => error.code === "EEXIST",
    );
    assert.equal(await readFile(target, "utf8"), "unrelated content");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("aborting mid-write cleans up the partial file", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "gate1-test-"));
  try {
    const target = resolve(dir, "aborted.bin");
    const controller = new AbortController();
    const writePromise = writeDeterministicArtifact(
      target,
      { seed: "public-test-seed", sizeBytes: 50 * 1024 * 1024 },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(writePromise);
    await assert.rejects(stat(target), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Hashing / JSON commitment
// ---------------------------------------------------------------------------

test("canonical JSON hash ignores object key order", () => {
  assert.equal(canonicalJsonSha256({ b: 2, a: 1 }), canonicalJsonSha256({ a: 1, b: 2 }));
  assert.equal(canonicalJsonSha256({ "é": 1, z: 2 }), canonicalJsonSha256({ z: 2, "é": 1 }));
});

// ---------------------------------------------------------------------------
// Secret linter
// ---------------------------------------------------------------------------

test("secret lint rejects credentials but allows public seed", () => {
  assert.deepEqual(lintSecrets({ env: { ARTIFACT_PUBLIC_SEED: "nosana-gate1-public-v1" } }), []);
  assert.equal(lintSecrets({ env: { API_KEY: "abc" } }).length, 1);
});

test("secret lint flags common credential shapes", () => {
  const cases: Array<[string, unknown]> = [
    ["Solana keypair byte array", Array.from({ length: 64 }, (_, i) => i % 256)],
    ["base58 Solana secret key material", "z".repeat(87)],
    ["JWT", `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`],
    ["GitHub token", `ghp_${"a".repeat(36)}`],
    ["Hugging Face token", `hf_${"a".repeat(20)}`],
    ["AWS access key", `AKIA${"A".repeat(16)}`],
    ["Bearer token", `Bearer ${"a".repeat(16)}`],
    // Built by concatenation, not a literal PEM header, so this benign test
    // fixture (there is no key material here) does not itself look like a
    // committed secret to generic secret-scanning tools.
    ["PEM private key", ["-----BEGIN RSA PRIV", "ATE KEY-----"].join("")],
  ];
  for (const [label, secret] of cases) {
    const findings = lintSecrets({ env: { SOME_VALUE: secret } });
    assert.ok(findings.length > 0, `expected a secret-lint finding for: ${label}`);
  }
});

test("ordinary (non-keypair-shaped) arrays in a job definition recurse cleanly", () => {
  const findings = lintSecrets({ ops: [{ id: "gate1-artifact-roundtrip", args: { gpu: true } }] });
  assert.deepEqual(findings, []);
});

test("public deterministic values do not trigger the secret linter", () => {
  const findings = lintSecrets({
    env: {
      ARTIFACT_PUBLIC_SEED: "nosana-gate1-public-v1",
      ARTIFACT_SIZE_BYTES: "10485760",
      ARTIFACT_OUTPUT_PATH: "/nosana/outputs/artifact.bin",
    },
    jobDefinitionSha256: canonicalJsonSha256("public-fixture"),
    market: SYSTEM_PROGRAM_ADDRESS,
    node: SYSTEM_PROGRAM_ADDRESS,
    resultReference: EXAMPLE_CID,
  });
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Evidence schema
// ---------------------------------------------------------------------------

test("simulation can never pass the live gate", () => {
  const hash = "a".repeat(64);
  const evidence: JobEvidence = {
    schemaVersion: "1.1.0", gateId: "gate1-artifact-roundtrip", executionMode: "simulation", gatePassed: true,
    nosanaJobId: null, market: null, node: null, jobDefinitionSha256: hash,
    submittedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), wallClockSeconds: 0.001,
    costNos: null, costUsd: null, resultReference: null,
    artifactExpectedSha256: hash, artifactActualSha256: hash, artifactExpectedBytes: 1, artifactActualBytes: 1,
    hashMatch: true, failureReason: null,
    verifiedAt: null, verifierVersion: null, independentJobState: null,
  };
  assert.throws(() => validateEvidence(evidence), /gatePassed contradicts evidence/);
});

test("a fully verified live evidence record can pass", () => {
  assert.doesNotThrow(() => validateEvidence(validLiveEvidenceFixture()));
});

test("live evidence cannot pass without independent provider, result and consistent timing", () => {
  for (const field of ["market", "node", "ipfsResult", "timeStart", "timeEnd", "priceRaw"] as const) {
    const evidence = validLiveEvidenceFixture();
    evidence.independentJobState![field] = null;
    assert.throws(() => validateEvidence(evidence), /gatePassed contradicts evidence/);
  }
  const missingIdentity = validLiveEvidenceFixture(); missingIdentity.market = null;
  assert.throws(() => validateEvidence(missingIdentity), /gatePassed contradicts evidence/);
  const wrongEnd = validLiveEvidenceFixture(); wrongEnd.independentJobState!.timeEnd = 61;
  assert.throws(() => validateEvidence(wrongEnd), /gatePassed contradicts evidence/);
});

test("hashMatch false can never produce gatePassed true", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.artifactActualSha256 = "b".repeat(64);
  evidence.hashMatch = false;
  // gatePassed still claims true - the point of the test
  assert.throws(() => validateEvidence(evidence), /gatePassed contradicts evidence/);
});

test("invalid SHA-256 value in evidence is rejected", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.artifactExpectedSha256 = "not-a-valid-hash";
  assert.throws(() => validateEvidence(evidence), /invalid SHA-256/);
});

test("malformed timestamps are rejected", () => {
  const submittedBad = validLiveEvidenceFixture();
  submittedBad.submittedAt = "not-a-real-timestamp";
  assert.throws(() => validateEvidence(submittedBad), /submittedAt is not a valid timestamp/);

  const completedBad = validLiveEvidenceFixture();
  completedBad.completedAt = "also-not-a-real-timestamp";
  assert.throws(() => validateEvidence(completedBad), /completedAt is not a valid timestamp/);
});

test("negative duration (completedAt before submittedAt) is rejected", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.submittedAt = new Date(10_000).toISOString();
  evidence.completedAt = new Date(0).toISOString();
  assert.throws(() => validateEvidence(evidence), /negative duration/);
});

test("wallClockSeconds inconsistent with submittedAt/completedAt is rejected", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.wallClockSeconds = 99_999;
  assert.throws(() => validateEvidence(evidence), /inconsistent/);
});

test("a fake live job ID and result reference cannot satisfy the gate without an independent-verification record", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.verifiedAt = null;
  evidence.verifierVersion = null;
  evidence.independentJobState = null;
  // nosanaJobId, resultReference and hashMatch all still look perfectly valid -
  // only the independent-verification fields are missing.
  assert.throws(() => validateEvidence(evidence), /gatePassed contradicts evidence/);
});

test("a job address or CID that does not look valid-looking cannot satisfy the gate", () => {
  const badJobId = validLiveEvidenceFixture();
  badJobId.nosanaJobId = "not-a-solana-address";
  assert.throws(() => validateEvidence(badJobId), /gatePassed contradicts evidence/);

  const badCid = validLiveEvidenceFixture();
  badCid.resultReference = "not-a-cid";
  assert.throws(() => validateEvidence(badCid), /gatePassed contradicts evidence/);
});

test("mismatched independently-fetched market/node cannot satisfy the gate", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.independentJobState = { ...evidence.independentJobState!, market: OTHER_ADDRESS };
  assert.throws(() => validateEvidence(evidence), /gatePassed contradicts evidence/);
});

test("independent job state that is not COMPLETED cannot satisfy the gate", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.independentJobState = { ...evidence.independentJobState!, status: "STOPPED" };
  assert.throws(() => validateEvidence(evidence), /gatePassed contradicts evidence/);
});

test("simulation evidence carrying a live job ID is rejected outright", () => {
  const hash = "a".repeat(64);
  const evidence: JobEvidence = {
    schemaVersion: "1.1.0", gateId: "gate1-artifact-roundtrip", executionMode: "simulation", gatePassed: false,
    nosanaJobId: SYSTEM_PROGRAM_ADDRESS, market: null, node: null, jobDefinitionSha256: hash,
    submittedAt: new Date(0).toISOString(), completedAt: new Date(1).toISOString(), wallClockSeconds: 0.001,
    costNos: null, costUsd: null, resultReference: null,
    artifactExpectedSha256: hash, artifactActualSha256: hash, artifactExpectedBytes: 1, artifactActualBytes: 1,
    hashMatch: true, failureReason: "simulation_is_not_live_evidence",
    verifiedAt: null, verifierVersion: null, independentJobState: null,
  };
  assert.throws(() => validateEvidence(evidence), /simulation cannot contain live identifiers/);
});

test("independentJobState.fetchedAt before completedAt is rejected", () => {
  const evidence = validLiveEvidenceFixture();
  evidence.independentJobState = { ...evidence.independentJobState!, fetchedAt: new Date(0).toISOString() };
  assert.throws(() => validateEvidence(evidence), /independentJobState.fetchedAt precedes completedAt/);
});

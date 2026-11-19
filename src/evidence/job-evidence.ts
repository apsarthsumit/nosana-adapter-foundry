export type ExecutionMode = "simulation" | "nosana-live";

/**
 * Concrete reasons a Gate 1 run did not pass. `artifact_not_retrievable` exists
 * specifically because @nosana/cli 1.0.133's `job post --output <path>` throws
 * "artifact support coming soon!" before doing anything
 * (node_modules/@nosana/cli/dist/src/cli/job/post/action.js:72-73, VERIFIED_FROM_FILES) -
 * until that ships, or an equivalent path is confirmed, no Gate 1 live run can
 * honestly claim to have retrieved the artifact through the CLI's own mechanism.
 */
export type FailureReason =
  | "simulation_is_not_live_evidence"
  | "no_host_available"
  | "job_timeout"
  | "host_execution_error"
  | "artifact_size_mismatch"
  | "artifact_hash_mismatch"
  | "retrieval_error"
  | "artifact_not_retrievable";

/**
 * A job-state record obtained by *independently* querying the Nosana SDK/API for
 * a job address that already appears in this evidence record (as opposed to the
 * submitter's own in-process bookkeeping). This is what turns a self-asserted
 * evidence file into something with external evidentiary weight: the fields here
 * are only meaningful if whoever populated them actually made that fetch. Nothing
 * in this module can verify that from the JSON alone - `validateEvidence` can only
 * check internal consistency and value *shape* (does this look like a Solana
 * address, does this look like an IPFS CID, do the two independently-reported
 * market/node values agree with each other). Shape validity is necessary but not
 * sufficient: it catches typos and fabricated garbage, it does not prove the chain
 * or the host ever said any of this.
 */
export interface IndependentJobState {
  fetchedAt: string;
  status: string;
  market: string | null;
  node: string | null;
  ipfsResult: string | null;
  timeStart: number | null;
  timeEnd: number | null;
  priceRaw: number | null;
}

export interface JobEvidence {
  schemaVersion: "1.1.0";
  gateId: "gate1-artifact-roundtrip";
  executionMode: ExecutionMode;
  gatePassed: boolean;
  nosanaJobId: string | null;
  market: string | null;
  node: string | null;
  jobDefinitionSha256: string;
  submittedAt: string;
  completedAt: string | null;
  wallClockSeconds: number | null;
  costNos: number | null;
  costUsd: number | null;
  resultReference: string | null;
  artifactExpectedSha256: string;
  artifactActualSha256: string | null;
  artifactExpectedBytes: number;
  artifactActualBytes: number | null;
  hashMatch: boolean;
  failureReason: FailureReason | null;
  /** Verifier's own clock, set only once independent verification has run. */
  verifiedAt: string | null;
  /** e.g. "gate1-verifier@1.1.0" - identifies which verification logic produced this record. */
  verifierVersion: string | null;
  independentJobState: IndependentJobState | null;
}

const sha256Pattern = /^[a-f0-9]{64}$/;

// Lifted verbatim from the installed CLI's own address-type check
// (node_modules/@nosana/cli/dist/src/cli/job/post/action.js:128, VERIFIED_FROM_FILES).
const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// CIDv0 (Qm... 46 chars) is what the CLI's own gateway URL construction implies
// (`${nosana.ipfs.config.gateway}${job.ipfsResult}`, get/action.js:101-102, VERIFIED_FROM_FILES).
// CIDv1 base32 is accepted defensively; neither is proof the CID resolves to anything - see
// IndependentJobState doc comment. This is a format check only (INFERENCE beyond CIDv0).
const ipfsCidPattern = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58,})$/;

function isValidTimestamp(value: string | null): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function looksLikeSolanaAddress(value: string | null): value is string {
  return value !== null && solanaAddressPattern.test(value);
}

function looksLikeIpfsCid(value: string | null): value is string {
  return value !== null && ipfsCidPattern.test(value);
}

/**
 * The single source of truth for what "passed" means. Kept as a pure function
 * (rather than inlined in validateEvidence) so validateEvidence can enforce that
 * `gatePassed` is not just "consistent with a true subset of these conditions"
 * but *exactly* this computed value in both directions - `gatePassed: true` with
 * a missing condition is rejected, and so is `gatePassed: false` when every
 * condition actually holds (silent under-reporting is also a bug).
 */
function computeGatePassed(value: JobEvidence): boolean {
  if (value.executionMode !== "nosana-live") return false;
  if (!value.hashMatch) return false;
  if (value.failureReason !== null) return false;
  if (!looksLikeSolanaAddress(value.nosanaJobId)) return false;
  if (!looksLikeSolanaAddress(value.market) || !looksLikeSolanaAddress(value.node)) return false;
  if (!looksLikeIpfsCid(value.resultReference)) return false;
  if (!isValidTimestamp(value.verifiedAt)) return false;
  if (!value.completedAt || Date.parse(value.verifiedAt as string) < Date.parse(value.completedAt)) return false;
  if (!value.verifierVersion) return false;

  const state = value.independentJobState;
  if (!state) return false;
  if (state.status !== "COMPLETED") return false;
  if (!isValidTimestamp(state.fetchedAt)) return false;
  if (state.market !== value.market || state.node !== value.node) return false;
  if (state.ipfsResult !== value.resultReference) return false;
  if (!Number.isSafeInteger(state.timeStart) || !Number.isSafeInteger(state.timeEnd)) return false;
  if (state.timeStart! < 0 || state.timeEnd! <= state.timeStart!) return false;
  if (state.timeEnd! * 1000 !== Date.parse(value.completedAt)) return false;
  if (!Number.isFinite(state.priceRaw) || state.priceRaw! < 0) return false;

  return true;
}

export function validateEvidence(value: JobEvidence): void {
  if (value.schemaVersion !== "1.1.0" || value.gateId !== "gate1-artifact-roundtrip") throw new Error("unsupported evidence schema");

  if (!sha256Pattern.test(value.jobDefinitionSha256) || !sha256Pattern.test(value.artifactExpectedSha256)) {
    throw new Error("invalid SHA-256 value");
  }
  if (!Number.isSafeInteger(value.artifactExpectedBytes) || value.artifactExpectedBytes < 1) throw new Error("invalid artifact size");

  const actualPresent = value.artifactActualSha256 !== null && value.artifactActualBytes !== null;
  if (actualPresent) {
    if (!sha256Pattern.test(value.artifactActualSha256 as string)) throw new Error("invalid SHA-256 value");
    if (!Number.isSafeInteger(value.artifactActualBytes) || (value.artifactActualBytes as number) < 0) throw new Error("invalid artifact size");
  }
  const expectedHashMatch =
    actualPresent &&
    value.artifactExpectedSha256 === value.artifactActualSha256 &&
    value.artifactExpectedBytes === value.artifactActualBytes;
  if (value.hashMatch !== expectedHashMatch) throw new Error("hashMatch contradicts artifact evidence");

  if (!isValidTimestamp(value.submittedAt)) throw new Error("submittedAt is not a valid timestamp");
  if (value.completedAt !== null) {
    if (!isValidTimestamp(value.completedAt)) throw new Error("completedAt is not a valid timestamp");
    if (Date.parse(value.completedAt) < Date.parse(value.submittedAt)) throw new Error("completedAt precedes submittedAt (negative duration)");
  }
  if (value.wallClockSeconds !== null) {
    if (!Number.isFinite(value.wallClockSeconds) || value.wallClockSeconds < 0) throw new Error("wallClockSeconds is negative or non-finite");
    if (value.completedAt !== null) {
      const expectedSeconds = (Date.parse(value.completedAt) - Date.parse(value.submittedAt)) / 1000;
      if (Math.abs(value.wallClockSeconds - expectedSeconds) > 1) throw new Error("wallClockSeconds is inconsistent with submittedAt/completedAt");
    }
  }

  if (
    value.executionMode === "simulation" &&
    (value.nosanaJobId !== null || value.resultReference !== null || value.independentJobState !== null || value.verifiedAt !== null)
  ) {
    throw new Error("simulation cannot contain live identifiers or independent verification data");
  }

  if (value.independentJobState !== null) {
    if (!isValidTimestamp(value.independentJobState.fetchedAt)) throw new Error("independentJobState.fetchedAt is not a valid timestamp");
    if (value.completedAt !== null && Date.parse(value.independentJobState.fetchedAt) < Date.parse(value.completedAt)) {
      throw new Error("independentJobState.fetchedAt precedes completedAt");
    }
  }

  if (value.verifiedAt !== null && !isValidTimestamp(value.verifiedAt)) throw new Error("verifiedAt is not a valid timestamp");

  if (value.gatePassed !== computeGatePassed(value)) throw new Error("gatePassed contradicts evidence");
}

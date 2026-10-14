import { validateEvidence, type FailureReason, type IndependentJobState, type JobEvidence } from "../evidence/job-evidence.ts";

/** On-chain job record as returned by `@nosana/sdk` jobs.get (read without any wallet). */
export interface ChainJob {
  state: string;
  market: string;
  node: string;
  ipfsResult: string | null;
  timeStart: number;
  timeEnd: number;
  /** Price per second in NOS micro-units. */
  priceRaw: number;
}

export interface LiveEvidenceInput {
  jobId: string;
  jobDefinitionSha256: string;
  submittedAt: Date;
  chain: ChainJob;
  chainFetchedAt: Date;
  verifiedAt: Date;
  expectedSha256: string;
  expectedBytes: number;
  /** null when the artifact could not be retrieved. */
  retrieved: { sha256: string; bytes: number } | null;
  /** Set by the caller when something other than a hash check failed. */
  failureReason?: FailureReason;
  verifierVersion: string;
}

export function buildLiveEvidence(input: LiveEvidenceInput): JobEvidence {
  const { chain, retrieved } = input;
  const completedAt = new Date(chain.timeEnd * 1000);
  const hashMatch = retrieved !== null && retrieved.sha256 === input.expectedSha256 && retrieved.bytes === input.expectedBytes;

  let failureReason: FailureReason | null = input.failureReason ?? null;
  if (failureReason === null) {
    if (retrieved === null) failureReason = "retrieval_error";
    else if (retrieved.bytes !== input.expectedBytes) failureReason = "artifact_size_mismatch";
    else if (!hashMatch) failureReason = "artifact_hash_mismatch";
  }

  const independentJobState: IndependentJobState = {
    fetchedAt: input.chainFetchedAt.toISOString(),
    status: chain.state,
    market: chain.market,
    node: chain.node,
    ipfsResult: chain.ipfsResult,
    timeStart: chain.timeStart,
    timeEnd: chain.timeEnd,
    priceRaw: chain.priceRaw,
  };

  const evidence: JobEvidence = {
    schemaVersion: "1.1.0",
    gateId: "gate1-artifact-roundtrip",
    executionMode: "nosana-live",
    gatePassed: false,
    nosanaJobId: input.jobId,
    market: chain.market,
    node: chain.node,
    jobDefinitionSha256: input.jobDefinitionSha256,
    submittedAt: input.submittedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    wallClockSeconds: (completedAt.getTime() - input.submittedAt.getTime()) / 1000,
    costNos: (chain.timeEnd - chain.timeStart) * chain.priceRaw / 1e6,
    costUsd: null,
    resultReference: chain.ipfsResult,
    artifactExpectedSha256: input.expectedSha256,
    artifactActualSha256: retrieved?.sha256 ?? null,
    artifactExpectedBytes: input.expectedBytes,
    artifactActualBytes: retrieved?.bytes ?? null,
    hashMatch,
    failureReason,
    verifiedAt: input.verifiedAt.toISOString(),
    verifierVersion: input.verifierVersion,
    independentJobState,
  };

  // gatePassed is derived, never asserted: set it true only if validateEvidence agrees.
  evidence.gatePassed = true;
  try {
    validateEvidence(evidence);
  } catch {
    evidence.gatePassed = false;
    validateEvidence(evidence);
  }
  return evidence;
}

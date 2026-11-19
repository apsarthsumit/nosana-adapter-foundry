import { INFERENCE_MODEL, INFERENCE_MODEL_REVISION, INFERENCE_PROMPTS } from "./inference-workload.ts";

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Checks the expected workload identity and result shape, not answer correctness. */
export function validateInferenceArtifacts(manifest: unknown, result: unknown): void {
  if (!object(manifest) || typeof manifest.resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(manifest.resultSha256) || !Number.isSafeInteger(manifest.resultBytes) || Number(manifest.resultBytes) <= 0) throw new Error("invalid inference artifact manifest");
  if (typeof manifest.gpu !== "string" || !manifest.gpu.trim() || /mock|simulation/i.test(manifest.gpu) || typeof manifest.seconds !== "number" || !Number.isFinite(manifest.seconds) || manifest.seconds <= 0) throw new Error("invalid inference runtime metadata");
  if (!object(result) || result.model !== INFERENCE_MODEL || result.revision !== INFERENCE_MODEL_REVISION || result.decoding !== "greedy") throw new Error("inference result workload identity does not match");
  if (!Array.isArray(result.results) || result.results.length !== INFERENCE_PROMPTS.length || !result.results.every((entry, i) => object(entry) && entry.prompt === INFERENCE_PROMPTS[i] && typeof entry.completion === "string" && entry.completion.trim().length > 0)) throw new Error("inference prompts or completions do not match");
}

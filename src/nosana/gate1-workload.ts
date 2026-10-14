// The Gate 1 workload as a Nosana deployment body. The in-container generator is a
// Python port of src/generator/deterministic-artifact.ts; test/live.test.ts runs
// the Python snippet and checks it against the TypeScript generator, because an
// earlier hand-written port used a different block derivation and failed its own
// hash assertion on a live node (evidence: job 7YDYSLrV..., AssertionError).

export const GATE1_SEED = "nosana-gate1-public-v1";
export const GATE1_ARTIFACT_SIZE_BYTES = 10 * 1024 * 1024;
export const GATE1_CONTAINER_IMAGE = "docker.io/nosana/pytorch-jupyter:2.0.0";
export const GATE1_OP_ID = "gate1-generate-and-serve";
export const GATE1_SERVE_PORT = 8000;
export const GATE1_ARTIFACT_PATH = "/nosana/outputs/artifact.bin";

/** Credit-paid jobs are rejected below 3000 s (JOB_LIST_ERROR observed 2026-10-14). */
export const MIN_CREDIT_TIMEOUT_MINUTES = 50;

/** Writes GATE1_ARTIFACT_PATH and sets `actual` (hex SHA-256). Needs only the stdlib. */
export function pythonGenerateSnippet(seed: string, sizeBytes: number, path: string): string {
  return [
    "import hashlib,os",
    `seed=${JSON.stringify(seed)}`,
    `size=${sizeBytes}`,
    `p=${JSON.stringify(path)}`,
    "os.makedirs(os.path.dirname(p),exist_ok=True)",
    "h=hashlib.sha256()",
    "rem=size",
    "c=0",
    "with open(p,'wb') as f:",
    "    while rem>0:",
    "        b=hashlib.sha256(('nosana-gate1-v1\\0'+seed+'\\0'+str(c)).encode()).digest()",
    "        ch=b[:min(len(b),rem)]",
    "        f.write(ch); h.update(ch); rem-=len(ch); c+=1",
    "actual=h.hexdigest()",
  ].join("\n");
}

export function buildServeScript(expectedSha256: string): string {
  return [
    "import json,http.server,torch",
    pythonGenerateSnippet(GATE1_SEED, GATE1_ARTIFACT_SIZE_BYTES, GATE1_ARTIFACT_PATH),
    `expected=${JSON.stringify(expectedSha256)}`,
    "assert torch.cuda.is_available()",
    "x=torch.arange(1024*1024,dtype=torch.float32,device='cuda').reshape(1024,1024)",
    "y=torch.matmul(x[:256,:],x[:,:256])",
    "torch.cuda.synchronize()",
    "assert actual==expected, actual",
    "print(json.dumps({'artifactBytes':size,'artifactSha256':actual,'expectedSha256':expected,'gpu':torch.cuda.get_device_name(0),'gpuOperationResult':float(y[0,0].item()),'hashMatch':True},sort_keys=True),flush=True)",
    "os.chdir(os.path.dirname(p))",
    `http.server.ThreadingHTTPServer(('0.0.0.0',${GATE1_SERVE_PORT}),http.server.SimpleHTTPRequestHandler).serve_forever()`,
  ].join("\n");
}

export interface DeploymentBodyInput {
  name: string;
  market: string;
  timeoutMinutes: number;
  expectedSha256: string;
  vramMb?: number;
}

export function buildDeploymentBody(input: DeploymentBodyInput) {
  if (input.timeoutMinutes < MIN_CREDIT_TIMEOUT_MINUTES) {
    throw new Error(`timeoutMinutes must be at least ${MIN_CREDIT_TIMEOUT_MINUTES} for credit-paid jobs`);
  }
  return {
    name: input.name,
    market: input.market,
    replicas: 1,
    timeout: input.timeoutMinutes,
    confidential: true,
    strategy: "SIMPLE" as const,
    job_definition: {
      version: "0.1",
      type: "container",
      meta: { trigger: "deployment-manager", system_requirements: { vram_total_mb: input.vramMb ?? 4096 } },
      ops: [
        {
          type: "container/run",
          id: GATE1_OP_ID,
          args: {
            image: GATE1_CONTAINER_IMAGE,
            gpu: true,
            cmd: ["python3", "-u", "-c", buildServeScript(input.expectedSha256)],
            expose: GATE1_SERVE_PORT,
          },
        },
      ],
    },
  };
}

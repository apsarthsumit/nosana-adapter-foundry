// Real-model workload: greedy-decode a fixed prompt set with a pinned open model on
// a Nosana GPU, write result.json + manifest.json, and serve them for retrieval.
// The container reports the SHA-256 of result.json in manifest.json; the runner
// re-hashes the downloaded bytes, so the check is transfer integrity, not output
// correctness. Cross-hardware bit-identical text is NOT claimed.

export const INFERENCE_MODEL = "Qwen/Qwen2.5-0.5B-Instruct"; // Apache-2.0, not gated
export const INFERENCE_MODEL_REVISION = "7ae557604adf67be50417f59c2c2f167def9a775";
export const INFERENCE_IMAGE = "docker.io/pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime";
export const INFERENCE_OP_ID = "inference-generate-and-serve";
export const INFERENCE_PORT = 8000;
export const INFERENCE_OUT_DIR = "/nosana/outputs";
export const INFERENCE_PROMPTS = [
  "In one sentence, what is a decentralized GPU network?",
  "List three risks of trusting an unverified compute provider.",
  "What does a SHA-256 digest of an output file prove, and what does it not prove?",
];
export const INFERENCE_MAX_NEW_TOKENS = 64;
const MIN_CREDIT_TIMEOUT_MINUTES = 50;

export function buildInferenceScript(): string {
  return [
    "import hashlib,json,os,time,torch,transformers",
    "from transformers import AutoModelForCausalLM, AutoTokenizer",
    `model_id=${JSON.stringify(INFERENCE_MODEL)}`,
    `rev=${JSON.stringify(INFERENCE_MODEL_REVISION)}`,
    `prompts=${JSON.stringify(INFERENCE_PROMPTS)}`,
    `out=${JSON.stringify(INFERENCE_OUT_DIR)}`,
    "assert torch.cuda.is_available()",
    "t0=time.time()",
    "print('python: imports ok, cuda',torch.version.cuda,flush=True)",
    "import threading,glob",
    "from huggingface_hub import snapshot_download",
    "def _progress():",
    "    while True:",
    "        n=sum(os.path.getsize(f) for f in glob.glob(os.path.expanduser('~/.cache/huggingface/**/*'),recursive=True) if os.path.isfile(f))",
    "        print('python: downloaded bytes',n,flush=True); time.sleep(10)",
    "threading.Thread(target=_progress,daemon=True).start()",
    "snapshot_download(model_id,revision=rev)",
    "print('python: weights downloaded',round(time.time()-t0,1),flush=True)",
    "tok=AutoTokenizer.from_pretrained(model_id,revision=rev)",
    "print('python: tokenizer loaded',round(time.time()-t0,1),flush=True)",
    "m=AutoModelForCausalLM.from_pretrained(model_id,revision=rev,torch_dtype=torch.float16).to('cuda').eval()",
    "print('python: model on gpu',round(time.time()-t0,1),flush=True)",
    "res=[]",
    "for q in prompts:",
    "    text=tok.apply_chat_template([{'role':'user','content':q}],tokenize=False,add_generation_prompt=True)",
    "    ids=tok(text,return_tensors='pt').to('cuda')",
    `    with torch.no_grad(): o=m.generate(**ids,max_new_tokens=${INFERENCE_MAX_NEW_TOKENS},do_sample=False)`,
    "    res.append({'prompt':q,'completion':tok.decode(o[0][ids['input_ids'].shape[1]:],skip_special_tokens=True)})",
    "os.makedirs(out,exist_ok=True)",
    "body=json.dumps({'model':model_id,'revision':rev,'decoding':'greedy','results':res},sort_keys=True,indent=1).encode()",
    "open(out+'/result.json','wb').write(body)",
    "man={'resultSha256':hashlib.sha256(body).hexdigest(),'resultBytes':len(body),'gpu':torch.cuda.get_device_name(0),'torch':torch.__version__,'transformers':transformers.__version__,'seconds':round(time.time()-t0,1)}",
    "open(out+'/manifest.json','w').write(json.dumps(man,sort_keys=True))",
    "print('RESULT_JSON '+json.dumps(json.loads(body)),flush=True)",
    "print(json.dumps(man,sort_keys=True),flush=True)",
  ].join("\n");
}

export interface InferenceBodyInput {
  name: string;
  market: string;
  timeoutMinutes: number;
  /** Cron expression: makes a repeating, non-confidential, exit-when-done deployment (no file server). */
  schedule?: string;
}

export function buildInferenceDeploymentBody(input: InferenceBodyInput) {
  const scheduled = input.schedule !== undefined;
  if (input.timeoutMinutes < MIN_CREDIT_TIMEOUT_MINUTES) throw new Error(`timeoutMinutes must be at least ${MIN_CREDIT_TIMEOUT_MINUTES} for credit-paid jobs`);
  return {
    name: input.name,
    market: input.market,
    replicas: 1,
    timeout: input.timeoutMinutes,
    confidential: !scheduled, // scheduled runs are public so their logs (result + digest) come back via the API
    ...(scheduled ? { strategy: "SCHEDULED" as const, schedule: input.schedule } : { strategy: "SIMPLE" as const }),
    job_definition: {
      version: "0.1",
      type: "container",
      meta: { trigger: "deployment-manager", system_requirements: { vram_total_mb: 8192 } },
      ops: [
        {
          type: "container/run",
          id: INFERENCE_OP_ID,
          args: {
            image: INFERENCE_IMAGE,
            gpu: true,
            cmd: ["bash", "-c", buildInferenceShell({ serve: !scheduled })],
            ...(scheduled ? {} : { expose: INFERENCE_PORT }),
          },
        },
      ],
    },
  };
}

/**
 * The shell wrapper starts the file server FIRST and appends every step to log.txt in
 * the served directory, so a stalled or failing confidential job can still be
 * diagnosed over its exposed endpoint (the dashboard returns no logs for those).
 */
export function buildInferenceShell(options: { serve?: boolean } = {}): string {
  const serve = options.serve ?? true;
  return [
    `mkdir -p ${INFERENCE_OUT_DIR} && cd ${INFERENCE_OUT_DIR}`,
    ...(serve ? [`python -m http.server ${INFERENCE_PORT} >/dev/null 2>&1 &`, "exec >> log.txt 2>&1"] : []),
    'echo "$(date -u +%T) start"; nvidia-smi -L; df -h / | tail -1',
    'echo "huggingface: $(curl -sI -m 10 https://huggingface.co | head -1)"',
    'echo "pypi: $(curl -sI -m 10 https://pypi.org | head -1)"',
    'echo "$(date -u +%T) pip install"',
    "pip install -q transformers==4.46.3 accelerate==1.1.1 || echo PIP_FAILED",
    'echo "$(date -u +%T) running model"',
    `python -u -c ${shellQuote(buildInferenceScript())} || echo "PYTHON_FAILED exit $?"`,
    'echo "$(date -u +%T) done"',
    ...(serve ? ["wait"] : []),
  ].join("\n");
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export interface InferenceManifest {
  resultSha256: string;
  resultBytes: number;
  gpu: string;
  torch: string;
  transformers: string;
  seconds: number;
}

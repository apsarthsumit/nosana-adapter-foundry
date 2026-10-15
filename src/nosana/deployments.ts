// Minimal Nosana dashboard-API client for deployments. Endpoints and the
// "Authorization: Bearer <api key>" scheme were exercised against mainnet on
// 2026-10-14 (create, start, stop, get, jobs, jobs/{job}, credits/balance).
// `fetch` is injected so tests never touch the network.

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export const DEFAULT_API_BASE = "https://dashboard.k8s.prd.nos.ci/api";

export interface Deployment {
  id: string;
  status: string;
  active_jobs: number;
  endpoints: Array<{ opId: string; port: number | string; url: string; online: boolean }>;
}

export interface DeploymentJob {
  job: string;
  node: string | null;
  state: string;
  market: string;
}

export interface JobOpState {
  operationId: string;
  status: string;
  exitCode?: number | null;
  logs?: Array<{ log: string }>;
  errors?: unknown[];
}

export interface DeploymentJobDetail {
  node?: string | null;
  state?: number | string;
  timeStart?: number;
  timeEnd?: number;
  jobResult?: { status?: string; opStates?: JobOpState[] } | null;
}

export class DeploymentsClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;

  constructor(apiKey: string, fetchImpl: FetchLike, base: string = DEFAULT_API_BASE) {
    if (!apiKey) throw new Error("NOSANA_API_KEY is required");
    this.apiKey = apiKey;
    this.fetchImpl = fetchImpl;
    this.base = base;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Nosana API ${method} ${path} failed with HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  creditBalance() {
    return this.request<{ assignedCredits: number; reservedCredits: number; settledCredits: number }>("GET", "/credits/balance");
  }
  create(body: unknown) {
    return this.request<Deployment>("POST", "/deployments/create", body);
  }
  start(id: string) {
    return this.request<{ status: string }>("POST", `/deployments/${id}/start`);
  }
  stop(id: string) {
    return this.request<{ status: string }>("POST", `/deployments/${id}/stop`);
  }
  get(id: string) {
    return this.request<Deployment>("GET", `/deployments/${id}`);
  }
  async jobs(id: string): Promise<DeploymentJob[]> {
    return (await this.request<{ jobs: DeploymentJob[] }>("GET", `/deployments/${id}/jobs`)).jobs;
  }
  /** One job of a deployment, including its operation states and (for non-confidential jobs) logs. */
  job(id: string, jobId: string) {
    return this.request<DeploymentJobDetail>("GET", `/deployments/${id}/jobs/${jobId}`);
  }

  /** Raw GET against a job's exposed endpoint; null on any non-200 (the node is still starting). */
  async fetchEndpointFile(endpointUrl: string, path: string): Promise<Uint8Array | null> {
    const res = await this.fetchImpl(`${endpointUrl.replace(/\/$/, "")}${path}`);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  }
}

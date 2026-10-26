import { Readable } from 'node:stream';
import { z } from 'zod';
import { AppError } from './errors';

/**
 * Client for the Python sandbox agent (services/sandbox-agent). The agent is the ONLY component
 * that talks to the Docker engine. The wire format is snake_case JSON; see the agent's OpenAPI
 * document in docs/openapi/sandbox-agent.json.
 */

export type StepKind = 'clone' | 'install' | 'build';

export interface StepRequest {
  step_id: string;
  kind: StepKind;
  workspace_id: string;
  /** Toolchain key (e.g. "node-22", "python-3.12", "git"); the agent maps it to an allow-listed image. */
  toolchain: string;
  command?: string | null;
  env?: Record<string, string>;
  workdir?: string;
  timeout_seconds: number;
  network: 'none' | 'egress';
  memory_mb?: number;
  cpus?: number;
  pids?: number;
  source?:
    | { kind: 'https'; url: string; sha: string; token?: string }
    | { kind: 'local'; path: string; sha: string };
}

export interface StepResult {
  exit_code: number;
  timed_out: boolean;
  canceled: boolean;
  oom_killed: boolean;
  duration_ms: number;
}

export interface LogEvent {
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
}

const TreeSchema = z.object({
  files: z.array(z.object({ path: z.string(), size: z.number(), sha256: z.string() })),
  total_size: z.number(),
  skipped: z.array(z.string()).default([]),
});
export type TreeResponse = z.infer<typeof TreeSchema>;

const RuntimeSchema = z.object({
  deployment_id: z.string(),
  container: z.string(),
  host: z.string(),
  port: z.number(),
  status: z.enum(['starting', 'running', 'exited', 'missing', 'unhealthy']),
  healthy: z.boolean(),
});
export type RuntimeInfo = z.infer<typeof RuntimeSchema>;

export interface RuntimeRequest {
  deployment_id: string;
  toolchain: string;
  command: string;
  port: number;
  health_path: string;
  env: Record<string, string>;
  memory_mb?: number;
  cpus?: number;
  pids?: number;
  startup_timeout_seconds?: number;
}

export class SandboxUnavailableError extends AppError {
  constructor(msg = 'Sandbox agent is unavailable') {
    super('upstream_error', msg);
    this.name = 'SandboxUnavailableError';
  }
}

export class SandboxClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private async call(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<Response> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
      return res;
    } catch (err) {
      throw new SandboxUnavailableError(`Sandbox agent request failed: ${(err as Error).message}`);
    }
  }

  async health(): Promise<boolean> {
    try {
      const r = await this.call('/readyz', {}, 5_000);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Run a step and stream its logs. Resolves with the final result; rejects on transport errors. */
  async runStep(
    req: StepRequest,
    onLog: (e: LogEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<StepResult> {
    const res = await this.call(
      '/v1/steps',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      },
      // transport timeout: step timeout plus slack; the agent enforces the real limit
      (req.timeout_seconds + 120) * 1000,
    );
    if (!res.ok || !res.body) {
      throw new SandboxUnavailableError(`Sandbox agent rejected the step (${res.status})`);
    }
    let result: StepResult | null = null;
    const decoder = new TextDecoder();
    let buf = '';
    const handle = async (line: string) => {
      if (!line.trim()) return;
      let msg: { type: string } & Record<string, unknown>;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.type === 'log') {
        await onLog({ stream: (msg.stream as LogEvent['stream']) ?? 'stdout', line: String(msg.line ?? '') });
      } else if (msg.type === 'result') {
        result = {
          exit_code: Number(msg.exit_code),
          timed_out: Boolean(msg.timed_out),
          canceled: Boolean(msg.canceled),
          oom_killed: Boolean(msg.oom_killed),
          duration_ms: Number(msg.duration_ms ?? 0),
        };
      } else if (msg.type === 'error') {
        throw new SandboxUnavailableError(`Sandbox error: ${String(msg.message ?? 'unknown')}`);
      }
    };
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        await handle(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    }
    await handle(buf);
    if (!result) throw new SandboxUnavailableError('Sandbox stream ended without a result');
    return result;
  }

  async cancelStep(stepId: string): Promise<void> {
    await this.call(`/v1/steps/${encodeURIComponent(stepId)}`, { method: 'DELETE' }, 15_000).catch(() => undefined);
  }

  async tree(workspaceId: string, dir: string, limits: { maxFiles: number; maxBytes: number; maxFileBytes: number }) {
    const q = new URLSearchParams({
      dir,
      max_files: String(limits.maxFiles),
      max_bytes: String(limits.maxBytes),
      max_file_bytes: String(limits.maxFileBytes),
    });
    const res = await this.call(`/v1/workspaces/${encodeURIComponent(workspaceId)}/tree?${q}`, {}, 120_000);
    if (res.status === 404) throw new AppError('not_found', 'Build output directory not found');
    if (res.status === 413) throw new AppError('payload_too_large', 'Build output exceeds the configured limits');
    if (!res.ok) throw new SandboxUnavailableError(`Sandbox tree failed (${res.status})`);
    return TreeSchema.parse(await res.json());
  }

  async readFile(workspaceId: string, relPath: string): Promise<Readable> {
    const q = new URLSearchParams({ path: relPath });
    const res = await this.call(`/v1/workspaces/${encodeURIComponent(workspaceId)}/file?${q}`, {}, 120_000);
    if (!res.ok || !res.body) throw new SandboxUnavailableError(`Sandbox file read failed (${res.status})`);
    return Readable.fromWeb(res.body as never);
  }

  async pack(workspaceId: string, dir: string, limits: { maxBytes: number }): Promise<Readable> {
    const q = new URLSearchParams({ dir, max_bytes: String(limits.maxBytes) });
    const res = await this.call(`/v1/workspaces/${encodeURIComponent(workspaceId)}/pack?${q}`, {}, 600_000);
    if (res.status === 413) throw new AppError('payload_too_large', 'Application bundle exceeds the configured limits');
    if (!res.ok || !res.body) throw new SandboxUnavailableError(`Sandbox pack failed (${res.status})`);
    return Readable.fromWeb(res.body as never);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.call(`/v1/workspaces/${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }, 60_000).catch(
      () => undefined,
    );
  }

  async putBundle(deploymentId: string, body: Readable, maxBytes: number): Promise<void> {
    const res = await this.call(
      `/v1/bundles/${encodeURIComponent(deploymentId)}?max_bytes=${maxBytes}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/gzip' },
        body: Readable.toWeb(body) as never,
        // `duplex: "half"` is required by undici for streaming request bodies
        ...({ duplex: 'half' } as object),
      },
      600_000,
    );
    if (!res.ok) throw new SandboxUnavailableError(`Sandbox bundle upload failed (${res.status})`);
  }

  async startRuntime(req: RuntimeRequest): Promise<RuntimeInfo> {
    const res = await this.call(
      '/v1/runtimes',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) },
      ((req.startup_timeout_seconds ?? 60) + 30) * 1000,
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new AppError('upstream_error', `Runtime failed to start (${res.status}) ${detail.slice(0, 300)}`);
    }
    return RuntimeSchema.parse(await res.json());
  }

  async runtimeStatus(deploymentId: string): Promise<RuntimeInfo | null> {
    const res = await this.call(`/v1/runtimes/${encodeURIComponent(deploymentId)}`, {}, 15_000);
    if (res.status === 404) return null;
    if (!res.ok) throw new SandboxUnavailableError(`Runtime status failed (${res.status})`);
    return RuntimeSchema.parse(await res.json());
  }

  async runtimeLogs(deploymentId: string, tail = 200): Promise<string[]> {
    const res = await this.call(`/v1/runtimes/${encodeURIComponent(deploymentId)}/logs?tail=${tail}`, {}, 15_000);
    if (res.status === 404) return [];
    if (!res.ok) throw new SandboxUnavailableError(`Runtime logs failed (${res.status})`);
    const body = z.object({ lines: z.array(z.string()) }).parse(await res.json());
    return body.lines;
  }

  async stopRuntime(deploymentId: string): Promise<void> {
    await this.call(`/v1/runtimes/${encodeURIComponent(deploymentId)}`, { method: 'DELETE' }, 60_000);
  }
}

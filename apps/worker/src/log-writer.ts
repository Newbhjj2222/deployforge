import type { LogLevel, LogStream } from '@deployforge/db';
import { prisma } from '@deployforge/db';
import type { Redactor } from '@deployforge/core';

/**
 * Persists structured log lines for one deployment: redacted, size-limited, batched, and idempotent
 * (unique [deploymentId, seq] + skipDuplicates) so a retried attempt never double-writes a line.
 */
export class LogWriter {
  private seq = 0;
  private bytes = 0;
  private lines = 0;
  private buffer: Array<{ seq: number; ts: Date; level: LogLevel; stream: LogStream; message: string }> = [];
  private timer: NodeJS.Timeout | null = null;
  private truncated = false;
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly deploymentId: string,
    private readonly redact: Redactor,
    private readonly maxLines: number,
    private readonly maxBytes: number,
  ) {}

  /** Continue numbering after whatever is already stored (retries, cancel notices). */
  async init(): Promise<this> {
    const agg = await prisma.deploymentLog.aggregate({ where: { deploymentId: this.deploymentId }, _max: { seq: true }, _count: true });
    this.seq = (agg._max.seq ?? -1) + 1;
    this.lines = agg._count;
    return this;
  }

  add(message: string, level: LogLevel = 'INFO', stream: LogStream = 'SYSTEM'): void {
    if (this.truncated) return;
    const clean = this.redact(message);
    this.lines++;
    this.bytes += Buffer.byteLength(clean);
    if (this.lines > this.maxLines || this.bytes > this.maxBytes) {
      this.truncated = true;
      this.push('WARN', 'SYSTEM', `Log output truncated (limit of ${this.maxLines} lines / ${Math.round(this.maxBytes / 1024)} KiB reached). The build continues.`);
      return;
    }
    this.push(level, stream, clean);
  }

  system(message: string, level: LogLevel = 'INFO') {
    this.add(message, level, 'SYSTEM');
  }

  private push(level: LogLevel, stream: LogStream, message: string) {
    this.buffer.push({ seq: this.seq++, ts: new Date(), level, stream, message });
    if (this.buffer.length >= 100) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 400);
  }

  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const batch = this.buffer;
    this.buffer = [];
    if (batch.length === 0) return this.flushing;
    this.flushing = this.flushing.then(async () => {
      try {
        await prisma.deploymentLog.createMany({ data: batch.map((b) => ({ deploymentId: this.deploymentId, ...b })), skipDuplicates: true });
      } catch {
        // logging must never fail a build; lines are dropped if the database is unavailable
      }
    });
    return this.flushing;
  }
}

// In-memory job queue with a concurrency limit, a max length, idempotency by jobId
// and expiry of jobs that waited too long. State is lost on restart, which is fine:
// the Space is stateless and the user just sends the file again.

export interface QueueOptions<T> {
  concurrency: number;
  maxQueue: number;
  /** Jobs that waited longer than this in the queue are not run; `onExpired` is called instead. */
  maxAgeMs: number;
  /** How long a finished jobId is remembered for duplicate detection. */
  dedupeTtlMs?: number;
  run: (job: T) => Promise<void>;
  onExpired: (job: T) => Promise<void>;
  now?: () => number;
}

export type EnqueueResult =
  | { status: "queued"; position: number }
  | { status: "duplicate"; position: number }
  | { status: "full" };

interface Entry<T> { id: string; job: T; enqueuedAt: number }

export class JobQueue<T> {
  private waiting: Entry<T>[] = [];
  private active = 0;
  private seen = new Map<string, number>(); // jobId -> time first seen
  private idle: Array<() => void> = [];
  private readonly now: () => number;

  constructor(private opts: QueueOptions<T>) {
    this.now = opts.now ?? Date.now;
  }

  get queued(): number { return this.waiting.length; }
  get running(): number { return this.active; }

  /** Position 0 = starts right away; n = n jobs ahead of it in the waiting line. */
  enqueue(id: string, job: T): EnqueueResult {
    this.pruneSeen();
    if (this.seen.has(id)) {
      const idx = this.waiting.findIndex((e) => e.id === id);
      return { status: "duplicate", position: idx < 0 ? 0 : idx + 1 };
    }
    if (this.waiting.length >= this.opts.maxQueue) return { status: "full" };
    this.seen.set(id, this.now());
    this.waiting.push({ id, job, enqueuedAt: this.now() });
    const position = this.active >= this.opts.concurrency ? this.waiting.length : 0;
    this.pump();
    return { status: "queued", position };
  }

  /** Resolves when nothing is queued or running (used by tests and graceful shutdown). */
  onIdle(): Promise<void> {
    if (this.active === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  private pruneSeen() {
    const ttl = this.opts.dedupeTtlMs ?? 60 * 60 * 1000;
    const cutoff = this.now() - ttl;
    for (const [id, t] of this.seen) {
      if (t >= cutoff) break; // Map keeps insertion order = time order
      this.seen.delete(id);
    }
  }

  private pump() {
    while (this.active < this.opts.concurrency && this.waiting.length > 0) {
      const e = this.waiting.shift()!;
      this.active++;
      const expired = this.now() - e.enqueuedAt > this.opts.maxAgeMs;
      const p = expired ? this.opts.onExpired(e.job) : this.opts.run(e.job);
      p.catch((err) => console.error(JSON.stringify({ evt: "job_crash", err: String(err).slice(0, 300) })))
        .finally(() => {
          this.active--;
          this.pump();
          if (this.active === 0 && this.waiting.length === 0) this.idle.splice(0).forEach((r) => r());
        });
    }
  }
}

type Job = { start: () => void };

// Limit work that owns response buffers, not just the retained thumbnail LRU.
export class AsyncQueue {
  private active = 0;
  private readonly waiting = new Set<Job>();

  constructor(private readonly concurrency: number) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  }

  run<T>(load: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        if (this.waiting.delete(job)) reject(signal.reason);
      };
      const job: Job = { start: () => {
        signal.removeEventListener('abort', abort);
        this.active++;
        void Promise.resolve().then(() => {
          signal.throwIfAborted();
          return load();
        }).then(resolve, reject).finally(() => {
          this.active--;
          this.pump();
        });
      } };
      this.waiting.add(job);
      signal.addEventListener('abort', abort, { once: true });
      this.pump();
    });
  }

  private pump() {
    while (this.active < this.concurrency && this.waiting.size) {
      const job = this.waiting.values().next().value!;
      this.waiting.delete(job);
      job.start();
    }
  }
}

export type Review = { id: string; owner?: string; url: string; subject: string };
export type Registry = { add(entry: unknown): Review; remove(review: Review): void; openAll(): Review[] };
export type Route = { url: string; close(): Promise<void> };
type Reporter = { owner: string; token: object; ready(review: Review, url: string): void; error(message: string): void };
type Entry = { cancelled: boolean; route?: Route; pending: Promise<void>; error?: string };

export class ReviewLinks {
  private registry?: Registry;
  private readonly entries = new Map<Review, Entry>();
  private readonly closing = new Map<Review, Promise<void>>();
  private reporter?: Reporter;
  private enabled = true;
  private readonly publish: (url: string) => Promise<Route>;
  constructor(publish: (url: string) => Promise<Route>) { this.publish = publish; }

  reportWith(reporter: Reporter) { this.reporter = reporter; this.enabled = true; }
  clearReporter(token: object) { if (this.reporter?.token === token) this.reporter = undefined; }

  attach(registry: Registry) {
    if (this.registry === registry) { for (const review of registry.openAll()) this.track(review); return; }
    if (this.registry) throw new Error("Plannotator changed its review registry; restart Pi to reconnect phone links.");
    this.registry = registry;
    const add = registry.add.bind(registry), remove = registry.remove.bind(registry);
    registry.add = (entry) => { const review = add(entry); this.track(review); return review; };
    registry.remove = (review) => { try { remove(review); } finally { void this.remove(review).catch((error) => this.reportError(review, error)); } };
    for (const review of registry.openAll()) this.track(review);
  }

  private reportError(review: Review, error: unknown) {
    const message = error instanceof Error ? error.message : "Could not publish or close the review link.";
    const reporter = this.reporter;
    if (reporter && reporter.owner === review.owner) {
      try { reporter.error(message); } catch { /* A UI notification must not interrupt Pi. */ }
    }
  }

  private track(review: Review) {
    if (!this.enabled || this.entries.has(review)) return;
    const entry: Entry = { cancelled: false, pending: Promise.resolve() };
    this.entries.set(review, entry);
    entry.pending = (async () => {
      try {
        const route = await this.publish(review.url);
        if (entry.cancelled || !this.enabled) { await route.close(); return; }
        entry.route = route;
        const reporter = this.reporter;
        if (reporter && reporter.owner === review.owner) {
          try { reporter.ready(review, route.url); } catch { /* /phone-reviews can recover an undelivered link. */ }
        }
      } catch (error) {
        entry.error = error instanceof Error ? error.message : "Could not publish the review.";
        if (!entry.cancelled) this.reportError(review, error);
      }
    })();
  }

  remove(review: Review): Promise<void> {
    const closing = this.closing.get(review);
    if (closing) return closing;
    const entry = this.entries.get(review);
    if (!entry) return Promise.resolve();
    entry.cancelled = true; this.entries.delete(review);
    const pending = (async () => { await entry.pending; await entry.route?.close(); })();
    this.closing.set(review, pending);
    const finished = () => { this.closing.delete(review); };
    void pending.then(finished, finished);
    return pending;
  }

  async list(owner: string) {
    for (const review of this.registry?.openAll() ?? []) {
      const old = this.entries.get(review);
      if (old?.error) this.entries.delete(review);
      this.track(review);
    }
    await Promise.all([...this.entries.values()].map((entry) => entry.pending));
    return [...this.entries].filter(([review]) => review.owner === owner)
      .map(([review, entry]) => ({ id: review.id, subject: review.subject, url: entry.route?.url, error: entry.error }));
  }

  async stop() {
    this.enabled = false; this.reporter = undefined;
    await Promise.allSettled([...this.entries.keys()].map((review) => this.remove(review)).concat([...this.closing.values()]));
  }
}

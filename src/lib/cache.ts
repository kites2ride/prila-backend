type Entry<T> = { value: T; expiresAt: number };

export class TtlCache {
  private readonly store = new Map<string, Entry<unknown>>();

  /** @param maxEntries optional cap; oldest entries are evicted first (insertion order). */
  constructor(
    private readonly defaultTtlMs: number,
    private readonly maxEntries = Number.POSITIVE_INFINITY,
  ) {}

  get size(): number {
    return this.store.size;
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs = this.defaultTtlMs): void {
    if (ttlMs <= 0) return;
    this.store.delete(key);
    while (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  clear(): void {
    this.store.clear();
  }
}

/** Shared ~60s config cache */
export const configCache = new TtlCache(60_000, 20_000);

export type SecurePathHardeningCacheBounds = {
  maxEntries: number
  maxKeyBytes: number
  maxTotalKeyBytes: number
}

export const SECURE_PATH_HARDENING_CACHE_MAX_ENTRIES = 1024
export const SECURE_PATH_HARDENING_CACHE_KEY_MAX_BYTES = 64 * 1024
export const SECURE_PATH_HARDENING_CACHE_KEYS_MAX_BYTES = 512 * 1024

/**
 * The bounds every hardening cache uses unless a caller overrides them. They live here rather
 * than with one consumer so a cache can default itself instead of depending on some other module
 * being imported first.
 */
export const DEFAULT_HARDENING_CACHE_BOUNDS: SecurePathHardeningCacheBounds = {
  maxEntries: SECURE_PATH_HARDENING_CACHE_MAX_ENTRIES,
  maxKeyBytes: SECURE_PATH_HARDENING_CACHE_KEY_MAX_BYTES,
  maxTotalKeyBytes: SECURE_PATH_HARDENING_CACHE_KEYS_MAX_BYTES
}

type RetainedSecurePath<T> = {
  value: T
  keyBytes: number
}

export class SecurePathHardeningCache<T> {
  private readonly entries = new Map<string, RetainedSecurePath<T>>()
  private retainedKeyBytes = 0

  constructor(private readonly bounds: SecurePathHardeningCacheBounds) {}

  get(path: string): T | undefined {
    const retained = this.entries.get(path)
    if (!retained) {
      return undefined
    }
    this.entries.delete(path)
    this.entries.set(path, retained)
    return retained.value
  }

  set(path: string, value: T): boolean {
    const keyBytes = Buffer.byteLength(path, 'utf8')
    this.delete(path)
    if (
      keyBytes > this.bounds.maxKeyBytes ||
      keyBytes > this.bounds.maxTotalKeyBytes ||
      this.bounds.maxEntries <= 0
    ) {
      return false
    }
    while (
      this.entries.size >= this.bounds.maxEntries ||
      this.retainedKeyBytes + keyBytes > this.bounds.maxTotalKeyBytes
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) {
        return false
      }
      this.delete(oldest)
    }
    this.entries.set(path, { value, keyBytes })
    this.retainedKeyBytes += keyBytes
    return true
  }

  delete(path: string): void {
    const retained = this.entries.get(path)
    if (!retained) {
      return
    }
    this.entries.delete(path)
    this.retainedKeyBytes -= retained.keyBytes
  }

  clear(): void {
    this.entries.clear()
    this.retainedKeyBytes = 0
  }

  state(): { entries: number; keyBytes: number; paths: string[] } {
    return {
      entries: this.entries.size,
      keyBytes: this.retainedKeyBytes,
      paths: [...this.entries.keys()]
    }
  }
}

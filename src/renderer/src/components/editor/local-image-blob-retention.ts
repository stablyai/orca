export const MAX_LOCAL_IMAGE_BLOB_ENTRIES = 100
export const MAX_LOCAL_IMAGE_BLOB_BYTES = 128 * 1024 * 1024

export type RetainedLocalImageBlob = {
  url: string
  bytes: number
}

export class LocalImageBlobRetention {
  private readonly entries = new Map<string, RetainedLocalImageBlob>()
  private retained = 0

  constructor(private readonly revoke: (url: string) => void) {}

  get(key: string): string | undefined {
    return this.entries.get(key)?.url
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  set(key: string, entry: RetainedLocalImageBlob): void {
    const previous = this.entries.get(key)
    if (previous) {
      this.entries.delete(key)
      this.retained -= previous.bytes
      if (previous.url !== entry.url) {
        this.revoke(previous.url)
      }
    }
    this.entries.set(key, entry)
    this.retained += entry.bytes
    while (
      this.entries.size > MAX_LOCAL_IMAGE_BLOB_ENTRIES ||
      this.retained > MAX_LOCAL_IMAGE_BLOB_BYTES
    ) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      const oldest = this.entries.get(oldestKey)
      this.entries.delete(oldestKey)
      this.retained -= oldest?.bytes ?? 0
      if (oldest) {
        this.revoke(oldest.url)
      }
    }
  }

  clear(): RetainedLocalImageBlob[] {
    const stale = Array.from(this.entries.values())
    this.entries.clear()
    this.retained = 0
    return stale
  }

  get retainedBytes(): number {
    return this.retained
  }
}

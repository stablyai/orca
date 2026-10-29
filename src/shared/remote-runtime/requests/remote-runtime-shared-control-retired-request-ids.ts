const DEFAULT_MAX_RETIRED_REQUEST_IDS = 2_048
const DEFAULT_RETIRED_REQUEST_ID_TTL_MS = 60_000

export class SharedControlRetiredRequestIds {
  private readonly ids = new Map<string, number>()
  private readonly maxIds: number
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(
    options: {
      maxIds?: number
      ttlMs?: number
      now?: () => number
    } = {}
  ) {
    this.maxIds = Math.max(1, options.maxIds ?? DEFAULT_MAX_RETIRED_REQUEST_IDS)
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_RETIRED_REQUEST_ID_TTL_MS)
    this.now = options.now ?? Date.now
  }

  retire(requestId: string): void {
    const now = this.now()
    this.pruneExpired(now)
    this.ids.delete(requestId)
    this.ids.set(requestId, now + this.ttlMs)
    while (this.ids.size > this.maxIds) {
      const oldestId = this.ids.keys().next().value
      if (oldestId === undefined) {
        return
      }
      this.ids.delete(oldestId)
    }
  }

  has(requestId: string): boolean {
    this.pruneExpired(this.now())
    return this.ids.has(requestId)
  }

  get size(): number {
    this.pruneExpired(this.now())
    return this.ids.size
  }

  private pruneExpired(now: number): void {
    for (const [requestId, expiresAt] of this.ids) {
      if (expiresAt <= now) {
        this.ids.delete(requestId)
      }
    }
  }
}

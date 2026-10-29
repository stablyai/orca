import { resolve } from 'node:path'

export const GROK_SESSION_PATH_CACHE_MAX_ENTRIES = 64
export const GROK_SESSION_SCAN_ACTIVE_ROOT_MAX = 4
export const GROK_SESSION_SCAN_QUEUE_MAX_ENTRIES = 64

export type GrokSessionPathScanner = (
  sessionsDir: string,
  sessionId: string,
  maxGroupEntries: number
) => Promise<string | null>

type PendingLookup = {
  key: string
  rootKey: string
  sessionsDir: string
  sessionId: string
  maxGroupEntries: number
  resolve: (path: string | null) => void
}

export class GrokSessionPathLookupQueue {
  private readonly successfulPaths = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<string | null>>()
  private readonly activeRoots = new Set<string>()
  private readonly pending: PendingLookup[] = []
  private scanner: GrokSessionPathScanner

  constructor(private readonly defaultScanner: GrokSessionPathScanner) {
    this.scanner = defaultScanner
  }

  getCached(sessionsDir: string, sessionId: string): string | null {
    const key = this.lookupKey(sessionsDir, sessionId)
    const cached = this.successfulPaths.get(key)
    if (!cached) {
      return null
    }
    this.successfulPaths.delete(key)
    this.successfulPaths.set(key, cached)
    return cached
  }

  find(sessionsDir: string, sessionId: string, maxGroupEntries: number): Promise<string | null> {
    const key = this.lookupKey(sessionsDir, sessionId)
    const cached = this.getCached(sessionsDir, sessionId)
    if (cached) {
      return Promise.resolve(cached)
    }
    const existing = this.inflight.get(key)
    if (existing) {
      return existing
    }
    const rootKey = this.rootKey(sessionsDir)
    let resolveLookup: (path: string | null) => void = () => undefined
    const lookup = new Promise<string | null>((resolvePromise) => {
      resolveLookup = resolvePromise
    })
    const pending = {
      key,
      rootKey,
      sessionsDir,
      sessionId,
      maxGroupEntries,
      resolve: resolveLookup
    }
    if (this.mustQueue(rootKey)) {
      if (this.pending.length >= GROK_SESSION_SCAN_QUEUE_MAX_ENTRIES) {
        return Promise.resolve(null)
      }
      this.inflight.set(key, lookup)
      this.pending.push(pending)
      this.drain()
      return lookup
    }
    this.inflight.set(key, lookup)
    this.start(pending)
    return lookup
  }

  clearForTests(): void {
    this.successfulPaths.clear()
    this.inflight.clear()
    this.activeRoots.clear()
    for (const pending of this.pending.splice(0)) {
      pending.resolve(null)
    }
    this.scanner = this.defaultScanner
  }

  setScannerForTests(scanner: GrokSessionPathScanner): void {
    this.scanner = scanner
  }

  private rootKey(sessionsDir: string): string {
    const root = resolve(sessionsDir)
    return process.platform === 'win32' ? root.toLowerCase() : root
  }

  private lookupKey(sessionsDir: string, sessionId: string): string {
    return `${this.rootKey(sessionsDir)}\0${sessionId}`
  }

  private mustQueue(rootKey: string): boolean {
    return (
      this.pending.length > 0 ||
      this.activeRoots.has(rootKey) ||
      this.activeRoots.size >= GROK_SESSION_SCAN_ACTIVE_ROOT_MAX
    )
  }

  private cache(key: string, path: string): void {
    this.successfulPaths.delete(key)
    this.successfulPaths.set(key, path)
    while (this.successfulPaths.size > GROK_SESSION_PATH_CACHE_MAX_ENTRIES) {
      const oldest = this.successfulPaths.keys().next().value
      if (typeof oldest !== 'string') {
        return
      }
      this.successfulPaths.delete(oldest)
    }
  }

  private start(pending: PendingLookup): void {
    this.activeRoots.add(pending.rootKey)
    void (async () => {
      try {
        const path = await this.scanner(
          pending.sessionsDir,
          pending.sessionId,
          pending.maxGroupEntries
        )
        if (path) {
          this.cache(pending.key, path)
        }
        pending.resolve(path)
      } catch {
        pending.resolve(null)
      } finally {
        this.activeRoots.delete(pending.rootKey)
        this.inflight.delete(pending.key)
        this.drain()
      }
    })()
  }

  private drain(): void {
    while (this.pending.length > 0 && this.activeRoots.size < GROK_SESSION_SCAN_ACTIVE_ROOT_MAX) {
      const next = this.pending[0]
      // Why: strict FIFO avoids starving repeated lookups for one sessions root.
      if (this.activeRoots.has(next.rootKey)) {
        return
      }
      this.pending.shift()
      this.start(next)
    }
  }
}

import { randomUUID } from 'node:crypto'
import type { GitHistoryRefs } from './git-history-types'

type PinnedHistory = {
  key: string
  revisions: string[]
  resolvedRefs?: string[]
  touched: number
  bytes: number
}
const MAX_BYTES = 8 * 1024 * 1024
const IDLE_MS = 15 * 60 * 1000

// Host-owned: reconnects and single-request sockets must keep the same pinned revision set.
export class GitHistoryTokenStore {
  private readonly entries = new Map<string, PinnedHistory>()
  private bytes = 0

  private prune(now: number): void {
    for (const [token, entry] of this.entries) {
      if (now - entry.touched >= IDLE_MS) {
        this.remove(token)
      }
    }
  }

  private remove(token: string): void {
    const entry = this.entries.get(token)
    if (entry) {
      this.bytes -= entry.bytes
    }
    this.entries.delete(token)
  }

  private key(cwd: string, refs: GitHistoryRefs): string {
    return JSON.stringify([cwd, Array.isArray(refs) ? [...new Set(refs)].sort() : refs])
  }

  get(token: string, cwd: string, refs: GitHistoryRefs): PinnedHistory | undefined {
    const now = Date.now()
    this.prune(now)
    const entry = this.entries.get(token)
    if (!entry || entry.key !== this.key(cwd, refs)) {
      return undefined
    }
    entry.touched = now
    this.entries.delete(token)
    this.entries.set(token, entry)
    return entry
  }

  put(cwd: string, refs: GitHistoryRefs, revisions: string[], resolvedRefs?: string[]): string {
    this.prune(Date.now())
    const key = this.key(cwd, refs)
    const bytes =
      2 * (key.length + revisions.join('').length + (resolvedRefs?.join('').length ?? 0))
    if (bytes > MAX_BYTES) {
      throw new Error('Git history revision set exceeds the host memory limit')
    }
    while (this.entries.size >= 32 || this.bytes + bytes > MAX_BYTES) {
      const oldest = this.entries.keys().next().value
      if (!oldest) {
        break
      }
      this.remove(oldest)
    }
    const token = randomUUID()
    this.entries.set(token, { key, revisions, resolvedRefs, bytes, touched: Date.now() })
    this.bytes += bytes
    return token
  }
}

export const gitHistoryTokens = new GitHistoryTokenStore()

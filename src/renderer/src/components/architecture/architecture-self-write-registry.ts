import { normalizeAbsolutePath } from '@/components/right-sidebar/file-explorer-paths'

// Why: architecture model writes fan back in through architecture:modelChanged
// a few ms later. Treating our own write as an external reload can drop
// transient sidebar state, including in-progress property edits.
const SELF_WRITE_TTL_MS = 5_000
const SELF_WRITE_EVENT_BUDGET = 2

const stamps = new Map<string, { expiresAt: number; remaining: number }>()

export function recordArchitectureSelfWrite(absolutePath: string): void {
  const key = normalizeAbsolutePath(absolutePath)
  const now = Date.now()
  const existing = stamps.get(key)
  stamps.set(key, {
    expiresAt: now + SELF_WRITE_TTL_MS,
    remaining:
      existing && existing.expiresAt > now
        ? existing.remaining + SELF_WRITE_EVENT_BUDGET
        : SELF_WRITE_EVENT_BUDGET
  })
}

export function hasRecentArchitectureSelfWrite(absolutePath: string): boolean {
  const key = normalizeAbsolutePath(absolutePath)
  const stamp = stamps.get(key)
  if (!stamp) {
    return false
  }
  if (Date.now() > stamp.expiresAt) {
    stamps.delete(key)
    return false
  }
  if (stamp.remaining <= 0) {
    stamps.delete(key)
    return false
  }
  stamp.remaining -= 1
  if (stamp.remaining <= 0) {
    stamps.delete(key)
  } else {
    stamps.set(key, stamp)
  }
  return true
}

export function __clearArchitectureSelfWriteRegistryForTests(): void {
  stamps.clear()
}

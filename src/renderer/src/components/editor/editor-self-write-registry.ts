import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'
import { MAX_TIMER_DELAY_MS } from '../../../../shared/timer-delay'

// Why: the editor's own save path writes to disk, which fans out as an
// fs:changed event back to useEditorExternalWatch a few ms later. Treating
// our own write as an "external" change schedules a setContent reload that
// resets the TipTap selection to the end of the document mid-typing — and,
// because the RichMarkdownEditor guards (lastCommittedMarkdownRef + current
// getMarkdown() round-trip) can drift by a trailing newline or soft-break,
// the reload can silently drop unsaved keystrokes as well. Stamping a path
// right before writeFile lets the watch hook ignore the echo event without
// touching the editor at all. Keyed by runtime owner + normalized absolute
// path, bounded by a short TTL so a genuinely external edit that lands after
// the window still gets picked up.
const SELF_WRITE_TTL_MS = 750
// Why: SSH/runtime watcher echoes travel a poll-plus-network path and can
// land seconds after the write. A local-sized TTL lets the echo arrive after
// the stamp expired, which raises a false changed-on-disk banner on remote
// tabs while typing with autosave on.
export const SELF_WRITE_REMOTE_TTL_MS = 3000
const SELF_WRITE_MAX_STAMPS = 256

export type RecentSelfWrite = {
  content: string | null
}

type SelfWriteStamp = RecentSelfWrite & {
  expiresAt: number
}

const stamps = new Map<string, SelfWriteStamp>()
let expiryTimer: ReturnType<typeof setTimeout> | null = null
let scheduledExpiryAt = Infinity

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  scheduledExpiryAt = Infinity
}

function scheduleExpiredSelfWriteCleanup(): void {
  let nextExpiryAt = Infinity
  for (const stamp of stamps.values()) {
    if (Number.isFinite(stamp.expiresAt)) {
      nextExpiryAt = Math.min(nextExpiryAt, stamp.expiresAt + 1)
    }
  }
  if (nextExpiryAt === Infinity) {
    clearExpiryTimer()
    return
  }
  if (expiryTimer !== null && scheduledExpiryAt <= nextExpiryAt) {
    return
  }
  clearExpiryTimer()
  scheduledExpiryAt = nextExpiryAt
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null
      scheduledExpiryAt = Infinity
      pruneExpiredSelfWrites()
      scheduleExpiredSelfWriteCleanup()
    },
    Math.min(MAX_TIMER_DELAY_MS, Math.max(0, nextExpiryAt - Date.now()))
  )
}

function selfWriteKey(absolutePath: string, runtimeEnvironmentId?: string | null): string {
  return `${runtimeEnvironmentId?.trim() || 'client'}::${normalizeAbsolutePathForComparison(absolutePath)}`
}

function pruneExpiredSelfWrites(now = Date.now()): void {
  for (const [key, stamp] of stamps) {
    if (now > stamp.expiresAt) {
      stamps.delete(key)
    }
  }
}

function enforceSelfWriteStampLimit(): void {
  while (stamps.size > SELF_WRITE_MAX_STAMPS) {
    const oldest = stamps.keys().next().value
    if (oldest === undefined) {
      break
    }
    stamps.delete(oldest)
  }
}

export function recordSelfWrite(
  absolutePath: string,
  content?: string,
  runtimeEnvironmentId?: string | null,
  ttlMs: number = SELF_WRITE_TTL_MS
): void {
  const now = Date.now()
  pruneExpiredSelfWrites(now)
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  // Why: a missing watcher echo should not leave stale path/content stamps in
  // memory for the whole renderer session.
  stamps.delete(key)
  stamps.set(key, {
    content: content ?? null,
    expiresAt: now + ttlMs
  })
  enforceSelfWriteStampLimit()
  scheduleExpiredSelfWriteCleanup()
}

export function clearSelfWrite(absolutePath: string, runtimeEnvironmentId?: string | null): void {
  stamps.delete(selfWriteKey(absolutePath, runtimeEnvironmentId))
  if (stamps.size === 0) {
    clearExpiryTimer()
  }
}

export function getRecentSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): RecentSelfWrite | null {
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  const stamp = stamps.get(key)
  if (!stamp) {
    return null
  }
  if (Date.now() > stamp.expiresAt) {
    stamps.delete(key)
    if (stamps.size === 0) {
      clearExpiryTimer()
    }
    return null
  }
  return { content: stamp.content }
}

export function hasRecentSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): boolean {
  return getRecentSelfWrite(absolutePath, runtimeEnvironmentId) !== null
}

export function __clearSelfWriteRegistryForTests(): void {
  clearExpiryTimer()
  stamps.clear()
}

export function __getSelfWriteRegistrySizeForTests(): number {
  return stamps.size
}

import { normalizeAbsolutePathForComparison } from '@/components/right-sidebar/file-explorer-paths'

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

// Why: a formatter can rewrite the file for as long as its own timeout, and its
// output is unknown until it exits, so its echoes cannot be matched by content.
export const SELF_WRITE_FORMATTER_PENDING_TTL_MS = 30_000

export type RecentSelfWrite = {
  content: string | null
  /** A format-on-save run may still rewrite the file; any content on disk is Orca's own. */
  formatterPending?: boolean
}

type SelfWriteStamp = RecentSelfWrite & {
  expiresAt: number
  /** Watcher work held back while the formatter runs, keyed so a burst of events keeps only the latest. */
  deferredReplays?: Map<string, () => void>
}

const stamps = new Map<string, SelfWriteStamp>()

function selfWriteKey(absolutePath: string, runtimeEnvironmentId?: string | null): string {
  return `${runtimeEnvironmentId?.trim() || 'client'}::${normalizeAbsolutePathForComparison(absolutePath)}`
}

// Why: replay outside the caller's stack so a replay that re-enters the registry sees the settled stamp.
function releaseDeferredReplays(stamp: SelfWriteStamp | undefined): void {
  for (const replay of stamp?.deferredReplays?.values() ?? []) {
    queueMicrotask(replay)
  }
}

function removeStamp(key: string): void {
  const stamp = stamps.get(key)
  stamps.delete(key)
  releaseDeferredReplays(stamp)
}

function pruneExpiredSelfWrites(now = Date.now()): void {
  for (const [key, stamp] of stamps) {
    if (now > stamp.expiresAt) {
      removeStamp(key)
    }
  }
}

function enforceSelfWriteStampLimit(): void {
  for (const [key, stamp] of stamps) {
    if (stamps.size <= SELF_WRITE_MAX_STAMPS) {
      return
    }
    // Why: a pending stamp may hold watcher events that only its settle replays; evicting it would lose them.
    if (!stamp.formatterPending) {
      stamps.delete(key)
    }
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
  const previous = stamps.get(key)
  stamps.delete(key)
  stamps.set(key, {
    content: content ?? null,
    expiresAt: now + ttlMs
  })
  enforceSelfWriteStampLimit()
  // Why: the formatter has settled, so events held back during its run are now verified against the real bytes.
  releaseDeferredReplays(previous)
}

export function recordFormatterPendingSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): void {
  const now = Date.now()
  pruneExpiredSelfWrites(now)
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  const previous = stamps.get(key)
  stamps.delete(key)
  stamps.set(key, {
    content: null,
    formatterPending: true,
    expiresAt: now + SELF_WRITE_FORMATTER_PENDING_TTL_MS,
    ...(previous?.formatterPending && previous.deferredReplays
      ? { deferredReplays: previous.deferredReplays }
      : {})
  })
  enforceSelfWriteStampLimit()
}

/**
 * While a formatter runs its bytes are unknown, so a watcher event cannot be judged yet.
 * Returns true when the work was held; it is replayed once the real stamp replaces the pending one.
 */
export function deferUntilFormatterSettles(
  absolutePath: string,
  runtimeEnvironmentId: string | null | undefined,
  replayKey: string,
  replay: () => void
): boolean {
  const stamp = stamps.get(selfWriteKey(absolutePath, runtimeEnvironmentId))
  if (!stamp?.formatterPending || Date.now() > stamp.expiresAt) {
    return false
  }
  ;(stamp.deferredReplays ??= new Map()).set(replayKey, replay)
  return true
}

export function clearSelfWrite(absolutePath: string, runtimeEnvironmentId?: string | null): void {
  removeStamp(selfWriteKey(absolutePath, runtimeEnvironmentId))
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
    removeStamp(key)
    return null
  }
  return stamp.formatterPending
    ? { content: stamp.content, formatterPending: true }
    : { content: stamp.content }
}

/**
 * Judged against the stamp as it is now, not as it was when a verification read
 * began: a read that straddles the formatter's rewrite must not flag Orca's own output.
 * A still-pending stamp accepts nothing — callers defer instead.
 */
export function isDiskContentExpectedBySelfWrite(
  absolutePath: string,
  runtimeEnvironmentId: string | null | undefined,
  diskContent: string | null | undefined
): boolean {
  const stamp = getRecentSelfWrite(absolutePath, runtimeEnvironmentId)
  if (!stamp) {
    return false
  }
  return !stamp.formatterPending && diskContent != null && stamp.content === diskContent
}

export function hasRecentSelfWrite(
  absolutePath: string,
  runtimeEnvironmentId?: string | null
): boolean {
  return getRecentSelfWrite(absolutePath, runtimeEnvironmentId) !== null
}

export function __clearSelfWriteRegistryForTests(): void {
  stamps.clear()
}

export function __getSelfWriteRegistrySizeForTests(): number {
  return stamps.size
}

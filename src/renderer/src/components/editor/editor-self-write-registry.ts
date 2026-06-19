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
const SELF_WRITE_MAX_STAMPS = 256

export type RecentSelfWrite = {
  content: string | null
}

type SelfWriteStamp = RecentSelfWrite & {
  expiresAt: number
}

const stamps = new Map<string, SelfWriteStamp>()

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
  runtimeEnvironmentId?: string | null
): void {
  const now = Date.now()
  pruneExpiredSelfWrites(now)
  const key = selfWriteKey(absolutePath, runtimeEnvironmentId)
  // Why: a missing watcher echo should not leave stale path/content stamps in
  // memory for the whole renderer session.
  stamps.delete(key)
  stamps.set(key, {
    content: content ?? null,
    expiresAt: now + SELF_WRITE_TTL_MS
  })
  enforceSelfWriteStampLimit()
}

export function clearSelfWrite(absolutePath: string, runtimeEnvironmentId?: string | null): void {
  stamps.delete(selfWriteKey(absolutePath, runtimeEnvironmentId))
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
  stamps.clear()
}

export function __getSelfWriteRegistrySizeForTests(): number {
  return stamps.size
}

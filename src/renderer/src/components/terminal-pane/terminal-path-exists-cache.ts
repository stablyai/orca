export const TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES = 1024

// Why (issue #5024): a path can be printed in the terminal a moment before the
// file it names actually exists. Caching that "missing" result forever leaves
// the link permanently dead even after the file appears. Re-probe negatives
// after a short window; positive results stay cached (files rarely vanish
// mid-session, and a stale positive fails gracefully on open).
const NEGATIVE_PATH_EXISTS_TTL_MS = 10_000

export type TerminalPathExistsProbe = { checkedAt: number; sequence: number }
type TerminalPathExistsCacheEntry = TerminalPathExistsProbe & { exists: boolean }
export type TerminalPathExistsCache = Map<string, TerminalPathExistsCacheEntry>

let lastTerminalPathExistsProbeSequence = 0

// Why: overlapping probes can start in the same millisecond, so `checkedAt`
// (kept for the negative TTL) cannot order them; the sequence can.
export function startTerminalPathExistsProbe(
  checkedAt: number = Date.now()
): TerminalPathExistsProbe {
  lastTerminalPathExistsProbeSequence += 1
  return { checkedAt, sequence: lastTerminalPathExistsProbeSequence }
}

// Why: POSIX-looking SSH paths are only meaningful inside their connection;
// local/runtime keys keep the legacy scope so existing hover probes stay hot.
export function getTerminalPathExistsCacheKey({
  absolutePath,
  connectionId,
  isRemoteRuntimePath,
  runtimeEnvironmentId
}: {
  absolutePath: string
  connectionId?: string | null
  isRemoteRuntimePath?: boolean
  runtimeEnvironmentId?: string | null
}): string {
  const runtimeId = runtimeEnvironmentId?.trim()
  if (isRemoteRuntimePath && runtimeId) {
    return `${runtimeId}\0${absolutePath}`
  }
  const sshConnectionId = connectionId?.trim()
  if (sshConnectionId) {
    return `ssh:${sshConnectionId}\0${absolutePath}`
  }
  return `${runtimeId || 'active'}\0${absolutePath}`
}

export function readTerminalPathExistsCache(
  cache: TerminalPathExistsCache,
  key: string,
  now: number = Date.now()
): boolean | undefined {
  const entry = cache.get(key)
  if (entry === undefined) {
    return undefined
  }
  // Why: an expired "missing" entry is treated as a cache miss so the caller
  // re-probes the filesystem (the file may have since been created).
  if (!entry.exists && now - entry.checkedAt >= NEGATIVE_PATH_EXISTS_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  cache.delete(key)
  cache.set(key, entry)
  return entry.exists
}

export function writeTerminalPathExistsCache(
  cache: TerminalPathExistsCache,
  key: string,
  exists: boolean,
  probe: TerminalPathExistsProbe = startTerminalPathExistsProbe()
): void {
  const existing = cache.get(key)
  // Why: overlapping probes can resolve out of order; an older result (e.g. a
  // stale "missing") must not replace a newer one.
  if (existing && existing.sequence > probe.sequence) {
    return
  }
  if (existing) {
    cache.delete(key)
  } else {
    // Why: terminal output can contain unbounded unique paths during long
    // sessions; keep recent link probes without retaining every path forever.
    while (cache.size >= TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) {
        break
      }
      cache.delete(oldestKey)
    }
  }
  cache.set(key, { exists, checkedAt: probe.checkedAt, sequence: probe.sequence })
}

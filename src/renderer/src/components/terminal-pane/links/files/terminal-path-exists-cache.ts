import {
  readRecentPathAnswer,
  writeRecentPathAnswer
} from '../../../../../../shared/file-links/recent-path-answers'

const NEGATIVE_PATH_EXISTS_TTL_MS = 10_000

export type TerminalPathExistsProbe = { checkedAt: number; sequence: number }
type TerminalPathExistsCacheEntry = TerminalPathExistsProbe & { exists: boolean }
export type TerminalPathExistsCache = Map<string, TerminalPathExistsCacheEntry>

let lastTerminalPathExistsProbeSequence = 0

export function startTerminalPathExistsProbe(
  checkedAt: number = Date.now()
): TerminalPathExistsProbe {
  lastTerminalPathExistsProbeSequence += 1
  return { checkedAt, sequence: lastTerminalPathExistsProbeSequence }
}

export function readTerminalPathExistence(
  cache: TerminalPathExistsCache,
  key: string,
  now: number = Date.now()
): boolean | undefined {
  const entry = cache.get(key)
  if (entry === undefined) {
    return undefined
  }
  // Keep expired entries to reject older probes that complete after a newer result.
  if (!entry.exists && now - entry.checkedAt >= NEGATIVE_PATH_EXISTS_TTL_MS) {
    return undefined
  }
  return readRecentPathAnswer(cache, key)?.exists
}

export function writeTerminalPathExistence(
  cache: TerminalPathExistsCache,
  key: string,
  exists: boolean,
  probe: TerminalPathExistsProbe = startTerminalPathExistsProbe()
): void {
  const existing = cache.get(key)
  if (existing && existing.sequence > probe.sequence) {
    return
  }
  writeRecentPathAnswer(cache, key, { exists, ...probe })
}

// Scope POSIX SSH paths by connection; local/runtime cache keys retain legacy scope.
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

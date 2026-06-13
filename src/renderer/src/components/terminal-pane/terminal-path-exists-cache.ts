export const TERMINAL_PATH_EXISTS_CACHE_MAX_ENTRIES = 1024

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
  cache: Map<string, boolean>,
  key: string
): boolean | undefined {
  const value = cache.get(key)
  if (value !== undefined) {
    cache.delete(key)
    cache.set(key, value)
  }
  return value
}

export function writeTerminalPathExistsCache(
  cache: Map<string, boolean>,
  key: string,
  exists: boolean
): void {
  if (cache.has(key)) {
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
  cache.set(key, exists)
}

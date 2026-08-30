import { hasUnsafeProviderSessionIdChars } from './agent-session-resume'

const AGENT_WORKING_DIRECTORY_MAX_LENGTH = 4096

/** `\\server\share` at minimum: a bare `\\`, a server with no share, and the device
 *  namespaces `\\.\` / `\\?\` are not directories anything can start in, so a leading
 *  `\\` on its own is not enough to call a value absolute. */
const WINDOWS_NETWORK_PREFIX_PATTERN = /^[\\/]{2}/
const WINDOWS_DEVICE_NAMESPACE_PATTERN = /^[\\/]{2}[.?][\\/]/
const UNC_SHARE_PATTERN = /^[\\/]{2}[^\\/.?][^\\/]*[\\/][^\\/]+(?:[\\/]|$)/

/** POSIX root, Windows drive root, or UNC share. A relative path is meaningless
 *  without the process that emitted it, so it can only read as unknown. */
function isAbsoluteAgentWorkingDirectory(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return true
  }
  if (WINDOWS_NETWORK_PREFIX_PATTERN.test(value)) {
    return !WINDOWS_DEVICE_NAMESPACE_PATTERN.test(value) && UNC_SHARE_PATTERN.test(value)
  }
  return value.startsWith('/')
}

/** The directory the agent process itself reports it is rooted in, on the host that
 *  runs it. Never resolved against the local filesystem — an SSH/WSL agent reports a
 *  path that only exists on its own execution host. Absent means unknown, which is
 *  NOT the same as the pane's worktree (STA-5804). */
export function normalizeAgentWorkingDirectory(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const trimmed = raw.trim()
  if (
    trimmed.length === 0 ||
    trimmed.length > AGENT_WORKING_DIRECTORY_MAX_LENGTH ||
    hasUnsafeProviderSessionIdChars(trimmed) ||
    !isAbsoluteAgentWorkingDirectory(trimmed)
  ) {
    return undefined
  }
  return trimmed
}

/** Read the agent's own working directory off a raw hook payload. Claude and Codex
 *  report `cwd`; other providers spell it `workspaceRoot`/`workspace_root`. */
export function extractAgentWorkingDirectory(payload: Record<string, unknown>): string | undefined {
  for (const key of ['cwd', 'workspaceRoot', 'workspace_root'] as const) {
    const normalized = normalizeAgentWorkingDirectory(payload[key])
    if (normalized) {
      return normalized
    }
  }
  return undefined
}

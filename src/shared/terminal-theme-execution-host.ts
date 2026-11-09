/**
 * Which execution host a project's terminal theme is answered on. The same repo id can exist on
 * this host and on one or more SSH hosts, so every per-project map that crosses a host boundary
 * (renderer → main, main's store and seed, the push to each PTY owner) is keyed by host first.
 * One mapping for the three spellings involved: a Repo row's `connectionId`/`executionHostId`,
 * a PTY scope's `connectionId` (the bare SSH target id app PTY ids embed), and the SSH provider
 * registry key (that same target id).
 */
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId
} from './execution-host'

/** A host whose PTY owner this app pushes project colours to: itself, or an SSH relay it dials. */
export type TerminalThemeHostId = typeof LOCAL_EXECUTION_HOST_ID | `ssh:${string}`

/** Wire host keys are untrusted; only this host or an SSH host is a themeable one. */
export function normalizeTerminalThemeHostId(value: unknown): TerminalThemeHostId | null {
  const parsed = typeof value === 'string' ? parseExecutionHostId(value) : null
  if (parsed?.kind === 'local') {
    return LOCAL_EXECUTION_HOST_ID
  }
  // Why re-encoded: a stored `ssh:` id may use a non-canonical encoding; PTY scopes are built by toSshExecutionHostId.
  return parsed?.kind === 'ssh' ? toSshExecutionHostId(parsed.targetId) : null
}

/** The host a Repo row's theme belongs to; null for paired-runtime rows, whose PTYs no owner of
 *  this app answers for. */
export function getRepoTerminalThemeHostId(repo: {
  connectionId?: string | null
  executionHostId?: string | null
}): TerminalThemeHostId | null {
  return normalizeTerminalThemeHostId(getRepoExecutionHostId(repo))
}

/** The host a PTY's connection names: null is this host; otherwise the SSH target id, accepted
 *  in its bare or `ssh:` spelling because reconnect paths hand routers either. */
export function getConnectionTerminalThemeHostId(
  connectionId: string | null | undefined
): TerminalThemeHostId {
  if (!connectionId) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const parsed = parseExecutionHostId(connectionId)
  return toSshExecutionHostId(parsed?.kind === 'ssh' ? parsed.targetId : connectionId)
}

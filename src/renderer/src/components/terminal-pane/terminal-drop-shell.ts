import { resolveWindowsShellOverride } from '@/lib/pane-manager/windows-pty-compatibility'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { lastVerifiedRuntimeStatus } from '../../../../shared/runtime-host-status'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../../../shared/windows-terminal-shell'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { isWindowsUserAgent } from './pane-helpers'
import type { PtyTransport } from './pty-transport-types'

/** Path conventions of the host a dropped path is typed into. */
export type TerminalTargetShell = 'posix' | 'windows'

/** Null for a pane this client spawned; otherwise the host that owns it. */
export type TerminalDropRemoteHost = { runtimeEnvironmentId: string | null } | null

type HostPublishedShell = { terminalWindowsShell?: string | null }

type TerminalDropPaneShellState = {
  settings: { terminalWindowsShell?: string | null } | null
  tabsByWorktree: Record<
    string,
    readonly { id: string; shellOverride?: string | null }[] | undefined
  >
  runtimeStatusByEnvironmentId: ReadonlyMap<
    string,
    {
      status?: HostPublishedShell | null
      snapshot?: { status: HostPublishedShell | null } | null
    }
  >
}

export function getTerminalTargetShellForWorktreePath(worktreePath: string): TerminalTargetShell {
  if (isWslUncPath(worktreePath)) {
    return 'posix'
  }
  return isTerminalDropWindowsPathLike(worktreePath) ? 'windows' : 'posix'
}

export function resolveTerminalDropTargetShell({
  activeRuntimeEnvironmentId,
  worktreePath,
  connectionId,
  userAgent
}: {
  activeRuntimeEnvironmentId: string | null | undefined
  worktreePath: string | null | undefined
  connectionId: string | null | undefined
  userAgent?: string
}): TerminalTargetShell {
  if (activeRuntimeEnvironmentId?.trim() && worktreePath) {
    return getTerminalTargetShellForWorktreePath(worktreePath)
  }
  // Why: only a relay-era SSH row still has a connectionId, and its pane cannot accept input.
  if (typeof connectionId === 'string') {
    return 'posix'
  }
  if (worktreePath && isWslUncPath(worktreePath)) {
    return 'posix'
  }
  return isWindowsUserAgent(userAgent) ? 'windows' : 'posix'
}

export function isTerminalDropWindowsPathLike(path: string): boolean {
  if (isWslUncPath(path)) {
    return false
  }
  return isWindowsAbsolutePathLike(path) || path.includes('\\')
}

/**
 * Shell grammar a typed path is quoted for. Windows paths can land in
 * PowerShell, cmd or Git Bash, which disagree on quoting, so the pane's own
 * shell decides. A runtime-hosted pane takes its shell from the host's own
 * settings, which this client's setting and tab overrides do not describe, so
 * the default shell the host publishes decides, else PowerShell (the Windows default).
 */
export function resolveTerminalDropInputShell(args: {
  targetShell: TerminalTargetShell
  remoteHost: TerminalDropRemoteHost
  state: TerminalDropPaneShellState
  worktreeId: string
  tabId: string
  transport: Pick<PtyTransport, 'getLocalSessionMetadata'>
}): AgentStartupShell {
  if (args.targetShell === 'posix') {
    return 'posix'
  }
  if (args.remoteHost) {
    const environmentId = args.remoteHost.runtimeEnvironmentId
    const hostStatus = environmentId
      ? lastVerifiedRuntimeStatus(args.state.runtimeStatusByEnvironmentId.get(environmentId))
      : null
    return resolveWindowsShellStartupFamily(hostStatus?.terminalWindowsShell)
  }
  const tabShellOverride =
    args.transport.getLocalSessionMetadata?.()?.shellOverride ??
    args.state.tabsByWorktree[args.worktreeId]?.find((tab) => tab.id === args.tabId)?.shellOverride
  return resolveWindowsShellStartupFamily(
    resolveWindowsShellOverride(tabShellOverride, args.state.settings?.terminalWindowsShell)
  )
}

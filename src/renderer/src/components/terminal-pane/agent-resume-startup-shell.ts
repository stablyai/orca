import { useAppStore } from '@/store'
import { resolveWindowsShellOverride } from '@/lib/pane-manager/windows-pty-compatibility'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import { getConnectionId } from '@/lib/connection-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'

/**
 * Startup-shell family for a pane's host-authority agent resume.
 *
 * The host resolves this from the global `terminalWindowsShell` setting, which
 * misses a per-tab shell override; the renderer's own cold-restore path already
 * honours the override (#12320, #13095). Resolving it here and sending it with
 * the request keeps both restore paths on the same shell for the same pane.
 *
 * Returns `undefined` when the platform default is correct, which leaves the
 * request field absent and the host on its existing behaviour.
 */
export function resolveAgentResumeStartupShellForPane(
  worktreeId: string | undefined,
  tabId: string | undefined
): AgentStartupShell | undefined {
  if (!worktreeId) {
    return undefined
  }
  const state = useAppStore.getState()
  const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tabId)
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  return resolveLocalWindowsAgentStartupShell({
    platform: CLIENT_PLATFORM,
    isRemote:
      Boolean(getConnectionId(worktreeId)) ||
      parseExecutionHostId(executionHostId)?.kind !== 'local',
    terminalWindowsShell: resolveWindowsShellOverride(
      tab?.shellOverride,
      state.settings?.terminalWindowsShell
    )
  })
}

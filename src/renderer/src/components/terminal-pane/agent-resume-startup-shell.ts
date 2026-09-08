import { useAppStore } from '@/store'
import { resolveWindowsShellOverride } from '@/lib/pane-manager/windows-pty-compatibility'
import { getIndexedWorktreeById } from '@/store/worktree-repo-index'
import { getConnectionId } from '@/lib/connection-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'

/**
 * Startup-shell family for a pane's host-authority agent resume, or `undefined`
 * when the host's own resolution is already correct.
 *
 * The host resolves the shell from the global `terminalWindowsShell` setting,
 * which misses a per-tab override; the renderer's cold-restore path already
 * honours the override (#12320, #13095), so the same pane is quoted differently
 * depending on how it is restored. Sending the resolved value closes that gap.
 *
 * Deliberately narrow: only a local, native-Windows pane reports a shell. A WSL
 * worktree, a WSL-pinned project, an SSH workspace, or a non-local execution
 * host runs a POSIX shell that the client cannot classify from renderer state
 * alone, and guessing there would push Windows quoting into a POSIX shell — the
 * same #12320 failure, one dimension over. Those cases return `undefined` and
 * leave the host on its existing platform-aware resolution.
 */
export function resolveAgentResumeStartupShellForPane(
  worktreeId: string | undefined,
  tabId: string | undefined
): AgentStartupShell | undefined {
  if (!worktreeId || CLIENT_PLATFORM !== 'win32') {
    return undefined
  }
  const state = useAppStore.getState()
  const isRemote =
    Boolean(getConnectionId(worktreeId)) ||
    parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))?.kind !== 'local'
  const worktreePath = getIndexedWorktreeById(state.worktreesByRepo, worktreeId)?.path
  if (isRemote || (worktreePath && isWslUncPath(worktreePath))) {
    return undefined
  }
  const tab = (state.tabsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === tabId)
  return resolveLocalWindowsAgentStartupShell({
    platform: 'win32',
    isRemote: false,
    terminalWindowsShell: resolveWindowsShellOverride(
      tab?.shellOverride,
      state.settings?.terminalWindowsShell
    )
  })
}

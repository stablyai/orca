import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { workspaceHasSleepingAgentSessions } from '@/lib/worktree-agent-activation-gate'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { workspaceOwnerHostId } from '@/lib/workspace-row-owner-host'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import { tabHasLivePty } from '../../../../shared/tab-has-live-pty'
import { selectIsSleepingWorktree } from './use-worktree-sleep-state'

/**
 * A press may only switch to an awake local workspace from the terminal view whose terminals are all
 * running. Anything that would connect, boot, spawn or resume waits for the click, since a press can
 * still become a drag.
 */
export function canActivateWorktreeOnPress(args: {
  worktreeId: string
  rowHostId: ExecutionHostId | undefined
}): boolean {
  const state = useAppStore.getState()
  return (
    state.activeView === 'terminal' &&
    args.rowHostId === LOCAL_EXECUTION_HOST_ID &&
    // Host-focus subscribers resolve the workspace by bare id; a remote twin must not be the one they focus.
    workspaceOwnerHostId(state, args.worktreeId) === LOCAL_EXECUTION_HOST_ID &&
    !hasWorktreeSleepIntent(args.worktreeId) &&
    !workspaceHasSleepingAgentSessions(state, args.worktreeId) &&
    !selectIsSleepingWorktree(state, args.worktreeId) &&
    hasOnlyLiveTerminals(state, args.worktreeId)
  )
}

// Activation spawns a terminal for a dead or missing tab, which can boot a WSL distro on a Windows local project.
function hasOnlyLiveTerminals(
  state: Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'>,
  worktreeId: string
): boolean {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  return tabs.length > 0 && tabs.every((tab) => tabHasLivePty(state.ptyIdsByTabId, tab.id))
}

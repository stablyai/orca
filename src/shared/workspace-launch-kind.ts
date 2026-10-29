/** Derive launch kind from the resolved workspace ID on renderer and host. Floating has no backing row, uses its own directory setting and stays local; never trust caller-supplied kind. */

import type { AgentLaunchTarget } from './agent-launch-intent'
import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { parseWorkspaceKey } from './workspace-scope'

export type WorkspaceLaunchKind = 'git-worktree' | 'folder' | 'floating'

export function workspaceKindForWorktreeId(worktreeId: string): WorkspaceLaunchKind {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'floating'
  }
  return parseWorkspaceKey(worktreeId)?.type === 'folder' ? 'folder' : 'git-worktree'
}

/** Derive existing kind from the resolved ID, never a selector; create kind describes the workspace being created. */
export function workspaceKindForLaunchTarget(target: AgentLaunchTarget): WorkspaceLaunchKind {
  if (target.kind === 'existing') {
    return workspaceKindForWorktreeId(target.worktree)
  }
  return target.kind === 'create-folder-workspace' ? 'folder' : 'git-worktree'
}

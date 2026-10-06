/**
 * Which kind of workspace a launch lands in, read from the workspace's own id.
 *
 * The three kinds are not interchangeable to a launch: the floating workspace is a sentinel with no
 * backing repo, worktree or folder row, so its directory comes from the floating directory setting
 * and it always runs on the local host.
 *
 * It lives in `shared` because both sides of the launch ask the same question: the renderer when a
 * user opens an agent tab, and the host when it resolves an `agent.launch` target. A host must
 * never take the answer from a caller, so it derives it here from the id it resolved itself.
 */

import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { parseWorkspaceKey } from './workspace-scope'

export type WorkspaceLaunchKind = 'git-worktree' | 'folder' | 'floating'

export function workspaceKindForWorktreeId(worktreeId: string): WorkspaceLaunchKind {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'floating'
  }
  return parseWorkspaceKey(worktreeId)?.type === 'folder' ? 'folder' : 'git-worktree'
}

import type { AppState } from '@/store/types'
import {
  resolveAgentResumeLaunchTarget,
  type AgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { findForkWorktreeRepo } from './agent-session-fork-source-repo'

export type ForkAgentLaunchTarget = AgentResumeLaunchTarget

/** Where a native fork command runs and how it must be quoted, taken from the child's own host. */
export function getForkAgentLaunchTarget(
  state: AppState,
  worktreeId: string
): ForkAgentLaunchTarget {
  const worktree = state.getKnownWorktreeById(worktreeId)
  // Why: a bare repo id can match a local and an SSH repo; the wrong one quotes for the wrong shell.
  const repo = worktree ? findForkWorktreeRepo(state, worktree) : null
  return resolveAgentResumeLaunchTarget({
    projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
    connectionId: repo?.connectionId,
    executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
    worktreePath: worktree?.path,
    terminalWindowsShell: state.settings?.terminalWindowsShell
  })
}

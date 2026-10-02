import type { AppState } from '@/store/types'
import {
  resolveAgentResumeLaunchTarget,
  type AgentResumeLaunchTarget
} from '@/lib/agent-resume-launch-target'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { findForkWorktreeRepo } from './agent-session-fork-source-repo'

export type ForkAgentLaunchTarget = AgentResumeLaunchTarget & {
  /** Set when a remote Orca runtime owns the child, so the tab must be created on that host. */
  runtimeEnvironmentId: string | null
}

/** Where a native fork command runs and how it must be quoted, taken from the child's own host. */
export function getForkAgentLaunchTarget(
  state: AppState,
  worktreeId: string
): ForkAgentLaunchTarget {
  const worktree = state.getKnownWorktreeById(worktreeId)
  // Why: a bare repo id can match a local and an SSH repo; the wrong one quotes for the wrong shell.
  const repo = worktree ? findForkWorktreeRepo(state, worktree) : null
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (runtimeEnvironmentId && isWebRuntimeSessionActive(runtimeEnvironmentId)) {
    // Why: the host spawns this line, so the client's OS and shell settings say nothing about it.
    const platform = repo?.connectionId
      ? 'linux'
      : (lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId))
          ?.hostPlatform ?? 'linux')
    return {
      platform,
      shell: platform === 'win32' ? 'powershell' : undefined,
      runtimeEnvironmentId
    }
  }
  return {
    ...resolveAgentResumeLaunchTarget({
      projectRuntime: getLocalProjectExecutionRuntimeContext(state, worktreeId),
      connectionId: repo?.connectionId,
      executionHostId: getExecutionHostIdForWorktree(state, worktreeId),
      worktreePath: worktree?.path,
      terminalWindowsShell: state.settings?.terminalWindowsShell
    }),
    runtimeEnvironmentId: null
  }
}

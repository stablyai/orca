import type { AgentHookInstallState, AgentHookTarget } from '../../../shared/agent-hook-types'
import { isManagedAgentHookTarget } from '../../../shared/managed-agent-hook-targets'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type { TuiAgent } from '../../../shared/tui-agent'

// `skipped` is deliberate; `partial` can still strand the dot mid-turn.
const UNREPORTABLE_HOOK_INSTALL_STATES: ReadonlySet<AgentHookInstallState> = new Set([
  'not_installed',
  'partial',
  'error'
])

export type AgentHookInstallStateByTarget = Partial<Record<AgentHookTarget, AgentHookInstallState>>

export type WorktreeAgentObservabilityInput = {
  /** `launchAgent` of every tab in this worktree that currently has a live PTY. */
  liveAgents: readonly (TuiAgent | null | undefined)[]
  installStateByTarget: AgentHookInstallStateByTarget
  /** Null for local repos, an SSH target id for remote ones, undefined before the repo hydrates. */
  connectionId: string | null | undefined
  worktreePath: string | null | undefined
  /** True when a pane has a fresh, non-terminal hook row. */
  hasActiveHookEvidence: boolean
}

/** Local hook config cannot answer for SSH, unhydrated, or WSL workspaces. */
export function localHookConfigOwnsWorktree(
  connectionId: string | null | undefined,
  worktreePath: string | null | undefined
): boolean {
  if (connectionId !== null) {
    // Why: `undefined` is an unhydrated repo, not a local one — same decline.
    return false
  }
  return !(worktreePath && isWslUncPath(worktreePath))
}

/** Live managed agents whose local hook config cannot report status. */
export function getUnreportableLiveHookAgents(
  input: WorktreeAgentObservabilityInput
): AgentHookTarget[] {
  if (!localHookConfigOwnsWorktree(input.connectionId, input.worktreePath)) {
    return []
  }
  const seen = new Set<AgentHookTarget>()
  for (const agent of input.liveAgents) {
    if (!isManagedAgentHookTarget(agent) || seen.has(agent)) {
      continue
    }
    const state = input.installStateByTarget[agent]
    if (state !== undefined && UNREPORTABLE_HOOK_INSTALL_STATES.has(state)) {
      seen.add(agent)
    }
  }
  return [...seen]
}

/** Active hook evidence outranks a stale install snapshot. */
export function isWorktreeAgentStatusUnverifiable(input: WorktreeAgentObservabilityInput): boolean {
  if (input.hasActiveHookEvidence) {
    return false
  }
  return getUnreportableLiveHookAgents(input).length > 0
}

import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentDetectionTarget } from './useDetectedAgents'

export const AGENT_DETECTION_LOCAL_TARGET_KEY = 'local'

type AgentDetectionOwnerState = Parameters<typeof getConnectionIdFromState>[0] &
  WorktreeRuntimeOwnerState

/**
 * Resolve which host's agent detection a worktree's launch surfaces must use:
 * the owning SSH host, the owning paired-runtime host, or the local machine.
 * Returns undefined while the store has not hydrated the owning repo yet.
 *
 * Why a string key: selectors must return a stable primitive; building the
 * target object inside the selector would re-render subscribers on every
 * store write.
 */
export function getAgentDetectionTargetKeyForWorktree(
  state: AgentDetectionOwnerState,
  worktreeId: string | null
): string | undefined {
  if (worktreeId === null) {
    return AGENT_DETECTION_LOCAL_TARGET_KEY
  }
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    const explicitRuntimeEnvironmentId = getExplicitRuntimeEnvironmentIdForWorktree(
      state,
      worktreeId
    )
    if (explicitRuntimeEnvironmentId) {
      return `runtime:${explicitRuntimeEnvironmentId}`
    }
    // Why: a hostless folder can span local and SSH children, so keep the
    // ambiguity gate before applying its focused-runtime fallback.
    if (getConnectionIdFromState(state, worktreeId) === undefined) {
      return undefined
    }
  } else if (getResolvedExecutionHostIdForWorktree(state, worktreeId) === null) {
    // Why: repo rows can hydrate before a restored remote worktree; that gap
    // must stay unresolved instead of probing the repo row's local owner.
    return undefined
  }
  const executionHost = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))
  if (executionHost?.kind === 'ssh') {
    return `ssh:${executionHost.targetId}`
  }
  if (executionHost?.kind === 'runtime') {
    return `runtime:${executionHost.environmentId}`
  }
  return AGENT_DETECTION_LOCAL_TARGET_KEY
}

export function parseAgentDetectionTargetKey(
  key: string | undefined
): AgentDetectionTarget | undefined {
  if (key === undefined) {
    return undefined
  }
  if (key === AGENT_DETECTION_LOCAL_TARGET_KEY) {
    return { kind: 'local' }
  }
  if (key.startsWith('ssh:')) {
    return { kind: 'ssh', connectionId: key.slice('ssh:'.length) }
  }
  if (key.startsWith('runtime:')) {
    return { kind: 'runtime', environmentId: key.slice('runtime:'.length) }
  }
  return { kind: 'local' }
}

export function useAgentDetectionTargetForWorktree(
  worktreeId: string | null
): AgentDetectionTarget | undefined {
  const key = useAppStore((s) => getAgentDetectionTargetKeyForWorktree(s, worktreeId))
  return useMemo(() => parseAgentDetectionTargetKey(key), [key])
}

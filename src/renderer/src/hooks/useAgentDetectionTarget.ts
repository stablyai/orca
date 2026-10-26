import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/resolve-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentDetectionTarget } from './useDetectedAgents'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export const AGENT_DETECTION_LOCAL_TARGET_KEY = 'local'

// Why the workspace rides along: the paired host resolves that workspace's runtime (e.g. WSL).
function getRuntimeAgentDetectionTargetKey(environmentId: string, worktreeId: string): string {
  return `runtime:${encodeURIComponent(environmentId)}:${encodeURIComponent(worktreeId)}`
}

function getLocalAgentDetectionTargetKey(worktreeId: string): string {
  return worktreeId === FLOATING_TERMINAL_WORKTREE_ID
    ? `${AGENT_DETECTION_LOCAL_TARGET_KEY}:${encodeURIComponent(worktreeId)}:host`
    : AGENT_DETECTION_LOCAL_TARGET_KEY
}

export type AgentDetectionOwnerState = Parameters<typeof getConnectionIdFromState>[0] &
  WorktreeRuntimeOwnerState

/** Resolve the workspace’s proven local/SSH/runtime owner, remaining undefined through hydration. Return a primitive selector key to avoid allocating targets on every store write. */
export function getAgentDetectionTargetKeyForWorktree(
  state: AgentDetectionOwnerState,
  worktreeId: string | null
): string | undefined {
  if (worktreeId === null) {
    return AGENT_DETECTION_LOCAL_TARGET_KEY
  }
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
    // Why: probing one twin's agents would show the other host's install state.
    if (owner.kind === 'ambiguous') {
      return undefined
    }
    if (owner.environmentId) {
      return getRuntimeAgentDetectionTargetKey(owner.environmentId, worktreeId)
    }
    // Hostless folders can span hosts; reject ambiguity before focused-runtime fallback.
    if (getConnectionIdFromState(state, worktreeId) === undefined) {
      return undefined
    }
  } else if (getResolvedExecutionHostIdForWorktree(state, worktreeId) === null) {
    // Repo hydration can precede remote workspace ownership; stay unresolved instead of probing a misleading local repo row.
    return undefined
  }
  const executionHost = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))
  if (executionHost?.kind === 'ssh') {
    return `ssh:${executionHost.targetId}`
  }
  if (executionHost?.kind === 'runtime') {
    return getRuntimeAgentDetectionTargetKey(executionHost.environmentId, worktreeId)
  }
  return getLocalAgentDetectionTargetKey(worktreeId)
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
  if (key.startsWith(`${AGENT_DETECTION_LOCAL_TARGET_KEY}:`)) {
    const [encodedWorktreeId, encodedContextKey] = key
      .slice(`${AGENT_DETECTION_LOCAL_TARGET_KEY}:`.length)
      .split(':')
    if (!encodedWorktreeId || !encodedContextKey) {
      return { kind: 'local' }
    }
    try {
      return {
        kind: 'local',
        worktreeId: decodeURIComponent(encodedWorktreeId),
        contextKey: decodeURIComponent(encodedContextKey)
      }
    } catch {
      return { kind: 'local' }
    }
  }
  if (key.startsWith('ssh:')) {
    return { kind: 'ssh', connectionId: key.slice('ssh:'.length) }
  }
  if (key.startsWith('runtime:')) {
    const [encodedEnvironmentId = '', encodedWorktreeId] = key.slice('runtime:'.length).split(':')
    try {
      const environmentId = decodeURIComponent(encodedEnvironmentId)
      return encodedWorktreeId
        ? { kind: 'runtime', environmentId, worktreeId: decodeURIComponent(encodedWorktreeId) }
        : { kind: 'runtime', environmentId }
    } catch {
      return { kind: 'runtime', environmentId: encodedEnvironmentId }
    }
  }
  return { kind: 'local' }
}

export function useAgentDetectionTargetForWorktree(
  worktreeId: string | null
): AgentDetectionTarget | undefined {
  const key = useAppStore((s) => getAgentDetectionTargetKeyForWorktree(s, worktreeId))
  return useMemo(() => parseAgentDetectionTargetKey(key), [key])
}

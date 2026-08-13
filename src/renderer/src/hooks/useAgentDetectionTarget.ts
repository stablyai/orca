import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/resolved-worktree-execution-host'
import { getRuntimeEnvironmentIdForRepo } from '@/lib/repo-runtime-owner'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { Repo } from '../../../shared/types'
import type { AgentDetectionTarget } from './useDetectedAgents'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

export const AGENT_DETECTION_LOCAL_TARGET_KEY = 'local'

function getLocalAgentDetectionTargetKey(worktreeId: string): string {
  return worktreeId === FLOATING_TERMINAL_WORKTREE_ID
    ? `${AGENT_DETECTION_LOCAL_TARGET_KEY}:${encodeURIComponent(worktreeId)}:host`
    : AGENT_DETECTION_LOCAL_TARGET_KEY
}

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

/**
 * Resolve the detection host for a repository row that has no workspace yet.
 * Mirrors the host precedence the new-workspace composer uses for the same
 * repo (`useComposerState`), so a launch menu never offers an agent the
 * composer it opens cannot start. Returns undefined until the repo is known.
 */
export function useAgentDetectionTargetForRepo(
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | null | undefined
): AgentDetectionTarget | undefined {
  // Why: the caller already resolved which host owns this row's repo, so scope
  // the lookup to it — a bare id re-resolves and can pick the focused duplicate.
  const runtimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForRepo({ repos: repo ? [repo] : [], settings: s.settings }, repo?.id)
  )
  const repoHost = repo ? parseExecutionHostId(getRepoExecutionHostId(repo)) : null
  const connectionId = repoHost?.kind === 'ssh' ? repoHost.targetId : null
  const hasRepo = Boolean(repo)
  return useMemo(() => {
    if (!hasRepo) {
      return undefined
    }
    if (connectionId) {
      return { kind: 'ssh', connectionId }
    }
    // Why: covers both an explicit runtime owner and the focused-runtime
    // fallback a hostless repo inherits during a paired session.
    return runtimeEnvironmentId
      ? { kind: 'runtime', environmentId: runtimeEnvironmentId }
      : { kind: 'local' }
  }, [hasRepo, connectionId, runtimeEnvironmentId])
}

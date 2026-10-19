import type { AppState } from '@/store/types'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey,
  type AgentDetectionOwnerState
} from '@/hooks/useAgentDetectionTarget'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'

type DetectionReadState = Pick<
  AppState,
  | 'detectedAgentIds'
  | 'localDetectedAgentIdsByContext'
  | 'remoteDetectedAgentIds'
  | 'runtimeDetectedAgentIds'
>

type DetectionActionState = Pick<
  AppState,
  'ensureDetectedAgents' | 'ensureRemoteDetectedAgents' | 'ensureRuntimeDetectedAgents'
>

export type WorktreeAgentInventoryState = AgentDetectionOwnerState &
  DetectionReadState &
  DetectionActionState

/** The agent list a detection target's host last reported; null while it has not loaded. */
export function readDetectedAgentsForTarget(
  state: DetectionReadState,
  target: AgentDetectionTarget
): TuiAgent[] | null {
  if (target.kind === 'ssh') {
    return state.remoteDetectedAgentIds[target.connectionId] ?? null
  }
  if (target.kind === 'runtime') {
    const key = getRuntimeAgentInventoryKey(target.environmentId, target.worktreeId)
    return state.runtimeDetectedAgentIds[key] ?? null
  }
  return target.contextKey
    ? (state.localDetectedAgentIdsByContext[target.contextKey] ?? null)
    : state.detectedAgentIds
}

/** Loads a target's list from the host that owns it. */
export function ensureDetectedAgentsForTarget(
  state: DetectionActionState,
  target: AgentDetectionTarget
): Promise<TuiAgent[]> {
  if (target.kind === 'ssh') {
    return state.ensureRemoteDetectedAgents(target.connectionId)
  }
  if (target.kind === 'runtime') {
    return state.ensureRuntimeDetectedAgents(target.environmentId, target.worktreeId)
  }
  return state.ensureDetectedAgents(target.worktreeId)
}

function detectionTargetForWorktree(
  state: AgentDetectionOwnerState,
  worktreeId: string | null
): AgentDetectionTarget | undefined {
  const target = parseAgentDetectionTargetKey(
    getAgentDetectionTargetKeyForWorktree(state, worktreeId)
  )
  // Why: a local project's own runtime (native vs WSL) decides its PATH, not the focused one.
  return target?.kind === 'local' && !target.worktreeId && worktreeId
    ? { ...target, worktreeId }
    : target
}

/** The worktree host's agent list; null while unloaded or while its owner is unresolved. */
export function readDetectedAgentsForWorktree(
  state: AgentDetectionOwnerState & DetectionReadState,
  worktreeId: string | null
): TuiAgent[] | null {
  const target = detectionTargetForWorktree(state, worktreeId)
  return target ? readDetectedAgentsForTarget(state, target) : null
}

/**
 * Loads the worktree's agents from the host that runs them: a hub-owned SSH workspace asks the hub,
 * never this client's SSH map. An unresolved owner lists nothing rather than probing this machine.
 */
export function ensureDetectedAgentsForWorktree(
  state: WorktreeAgentInventoryState,
  worktreeId: string | null
): Promise<TuiAgent[]> {
  const target = detectionTargetForWorktree(state, worktreeId)
  return target ? ensureDetectedAgentsForTarget(state, target) : Promise.resolve([])
}

/** Which host's list a worktree reads now; changes when the workspace moves to another host. */
export function getDetectionTargetIdentityForWorktree(
  state: AgentDetectionOwnerState,
  worktreeId: string | null
): string | null {
  const target = detectionTargetForWorktree(state, worktreeId)
  return target ? JSON.stringify(target) : null
}

/** The worktree host's list, probing that host only when nothing usable is cached. */
export async function loadDetectedAgentsForWorktree(
  state: WorktreeAgentInventoryState,
  worktreeId: string | null
): Promise<TuiAgent[]> {
  const cached = readDetectedAgentsForWorktree(state, worktreeId)
  // Why: a shortcut pressed before the tab bar's probe lands must wait for it, not report "none".
  return cached?.length ? cached : ensureDetectedAgentsForWorktree(state, worktreeId)
}

export type RepoHostFields = { connectionId?: string | null; executionHostId?: string | null }

/**
 * A project's agents, for launches that run before the workspace exists. Null for a paired
 * server's project: that server resolves agents per workspace (its SSH target, a WSL project),
 * so only the new workspace can be asked — and never this client in its place.
 */
export function ensureDetectedAgentsForRepo(
  state: DetectionActionState,
  repo: RepoHostFields
): Promise<TuiAgent[]> | null {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'runtime') {
    return null
  }
  return host?.kind === 'ssh'
    ? state.ensureRemoteDetectedAgents(host.targetId)
    : state.ensureDetectedAgents()
}

/** A just-created workspace's agents; names it to its project's host while the new row hydrates. */
export function ensureDetectedAgentsForNewWorktree(
  state: WorktreeAgentInventoryState,
  worktreeId: string,
  repo: RepoHostFields
): Promise<TuiAgent[]> {
  const target = detectionTargetForWorktree(state, worktreeId)
  if (target) {
    return ensureDetectedAgentsForTarget(state, target)
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime'
    ? state.ensureRuntimeDetectedAgents(host.environmentId, worktreeId)
    : (ensureDetectedAgentsForRepo(state, repo) ?? Promise.resolve([]))
}

import type { AppState } from '@/store/types'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey,
  type AgentDetectionOwnerState
} from '@/hooks/useAgentDetectionTarget'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
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

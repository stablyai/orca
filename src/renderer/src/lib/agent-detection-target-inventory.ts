import type { AppState } from '@/store/types'
import type { AgentDetectionTarget } from '@/hooks/useDetectedAgents'
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

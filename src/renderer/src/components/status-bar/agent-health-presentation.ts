import type { AgentHealthSnapshot } from '../../../../shared/agent-health'
import {
  AGENT_READINESS_STATE_PRIORITY,
  type AgentProviderReadiness,
  type AgentReadinessProvider,
  type AgentReadinessState
} from './agent-readiness'

export function getAgentHealthSnapshot(
  snapshots: readonly AgentHealthSnapshot[],
  provider: AgentReadinessProvider
): AgentHealthSnapshot | null {
  return snapshots.find((snapshot) => snapshot.provider === provider) ?? null
}

function snapshotConnectionState(snapshot: AgentHealthSnapshot): AgentReadinessState {
  if (snapshot.cliStatus === 'unavailable') {
    return 'unavailable'
  }
  if (snapshot.checks.some((check) => check.id === 'authentication' && check.status === 'failed')) {
    return 'action-required'
  }
  if (snapshot.health === 'unhealthy' || snapshot.health === 'degraded') {
    return 'degraded'
  }
  return snapshot.health === 'healthy' ? 'ready' : 'unknown'
}

export function getProviderConnectionState(
  provider: AgentProviderReadiness,
  snapshot: AgentHealthSnapshot | null,
  healthPending: boolean
): AgentReadinessState {
  if (!snapshot && !healthPending) {
    return provider.state
  }
  const healthState = snapshot
    ? snapshotConnectionState(snapshot)
    : healthPending
      ? 'checking'
      : 'unknown'
  return AGENT_READINESS_STATE_PRIORITY[healthState] >
    AGENT_READINESS_STATE_PRIORITY[provider.state]
    ? healthState
    : provider.state
}

export function getOverallAgentConnectionState(
  providers: readonly AgentProviderReadiness[],
  snapshots: readonly AgentHealthSnapshot[],
  pendingProviders: Partial<Record<AgentReadinessProvider, boolean>>
): AgentReadinessState {
  return providers.reduce<AgentReadinessState>((current, provider) => {
    const state = getProviderConnectionState(
      provider,
      getAgentHealthSnapshot(snapshots, provider.provider),
      pendingProviders[provider.provider] === true
    )
    return AGENT_READINESS_STATE_PRIORITY[state] > AGENT_READINESS_STATE_PRIORITY[current]
      ? state
      : current
  }, 'ready')
}

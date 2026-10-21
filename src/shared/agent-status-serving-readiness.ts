import { AGENT_STATUS_RUNS_RUNTIME_CAPABILITY } from './agent-status-run-capability'
import { currentProducerAgentStatusLegacyIngressManifest } from './agent-status-legacy-ingress-manifest'

export type AgentStatusServingReadiness = Readonly<{
  servingReady: boolean
}>

export type AgentStatusServingGateEvidence = {
  readiness: AgentStatusServingReadiness
  currentProducerManifest: readonly unknown[]
}

/** 2A defines the gate but deliberately does not claim run-serving readiness. */
export const AGENT_STATUS_2A_SERVING_READINESS: AgentStatusServingReadiness = Object.freeze({
  servingReady: false
})

export function agentStatusRunServingGatePasses(evidence: AgentStatusServingGateEvidence): boolean {
  return evidence.readiness.servingReady && evidence.currentProducerManifest.length === 0
}

export function isAgentStatusRunServingAdvertised(readiness: AgentStatusServingReadiness): boolean {
  return agentStatusRunServingGatePasses({
    readiness,
    currentProducerManifest: currentProducerAgentStatusLegacyIngressManifest()
  })
}

export function advertisedAgentStatusRunCapabilities(
  readiness: AgentStatusServingReadiness
): readonly string[] {
  return isAgentStatusRunServingAdvertised(readiness)
    ? Object.freeze([AGENT_STATUS_RUNS_RUNTIME_CAPABILITY])
    : Object.freeze([])
}

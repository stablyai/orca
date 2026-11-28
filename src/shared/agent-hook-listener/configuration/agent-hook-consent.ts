import { AGENT_HOOK_TARGETS, type AgentHookTarget } from './agent-hook-types'

export type AgentHookConsentDecision = 'granted' | 'declined'

/** Per-agent answer to "Install hooks for <agent>?"; a missing agent has not been asked. */
export type AgentHookConsent = Partial<Record<AgentHookTarget, AgentHookConsentDecision>>

export type AgentHookConsentGlobalSettings = {
  /** Per-agent answer to "Install hooks for <agent>?"; a missing agent has not been asked. */
  agentHookConsent?: AgentHookConsent
}

type ConsentSettings = AgentHookConsentGlobalSettings | null | undefined

export function isAgentHookTarget(value: unknown): value is AgentHookTarget {
  return AGENT_HOOK_TARGETS.some((agent) => agent === value)
}

/** A paired client sends only the agents it decided; answers already on the host stay. */
export function agentHookConsentPatch(
  before: AgentHookConsent | undefined,
  update: unknown
): AgentHookConsentGlobalSettings {
  return update === undefined
    ? {}
    : { agentHookConsent: { ...before, ...parseAgentHookConsent(update) } }
}

export function readAgentHookConsent(
  settings: ConsentSettings,
  agent: AgentHookTarget
): AgentHookConsentDecision | null {
  const decision = settings?.agentHookConsent?.[agent]
  return decision === 'granted' || decision === 'declined' ? decision : null
}

/** Only agents whose hooks edit user config need an answer; per-launch plugins (OpenCode, pi) do not. */
export function isAgentHookConsentGranted(settings: ConsentSettings, agent: string): boolean {
  return !isAgentHookTarget(agent) || readAgentHookConsent(settings, agent) === 'granted'
}

export function withAgentHookConsent(
  current: AgentHookConsent | undefined,
  agents: readonly AgentHookTarget[],
  decision: AgentHookConsentDecision
): AgentHookConsent {
  const next: AgentHookConsent = { ...current }
  for (const agent of agents) {
    next[agent] = decision
  }
  return next
}

export function withoutAgentHookConsent(
  current: AgentHookConsent | undefined,
  agents: readonly AgentHookTarget[]
): AgentHookConsent {
  const next: AgentHookConsent = { ...current }
  for (const agent of agents) {
    delete next[agent]
  }
  return next
}

/** Keeps only known agents with a valid decision, for consent read from disk or the wire. */
export function parseAgentHookConsent(value: unknown): AgentHookConsent {
  const consent: AgentHookConsent = {}
  if (value === null || typeof value !== 'object') {
    return consent
  }
  for (const [agent, decision] of Object.entries(value)) {
    if (isAgentHookTarget(agent) && (decision === 'granted' || decision === 'declined')) {
      consent[agent] = decision
    }
  }
  return consent
}

/** Every agent not yet asked, recorded as granted; a decline stays. Servers have no card to ask. */
export function withUnaskedAgentsGranted(current: AgentHookConsent | undefined): AgentHookConsent {
  const unasked = AGENT_HOOK_TARGETS.filter((agent) => current?.[agent] === undefined)
  return withAgentHookConsent(current, unasked, 'granted')
}

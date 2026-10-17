import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'

export type AgentPostPasteSubmitInput = 'enter' | 'ctrl-enter'

function isAgentPostPasteSubmitInput(value: unknown): value is AgentPostPasteSubmitInput {
  return value === 'enter' || value === 'ctrl-enter'
}

export function normalizeAgentPostPasteSubmitInput(
  value: unknown
): AgentPostPasteSubmitInput | undefined {
  return isAgentPostPasteSubmitInput(value) ? value : undefined
}

export function normalizeAgentPostPasteSubmitInputs(
  value: unknown
): Partial<Record<TuiAgent, AgentPostPasteSubmitInput>> {
  const normalized: Partial<Record<TuiAgent, AgentPostPasteSubmitInput>> = {}
  if (!value || typeof value !== 'object') {
    return normalized
  }
  for (const [agent, submitInput] of Object.entries(value)) {
    const normalizedSubmitInput = normalizeAgentPostPasteSubmitInput(submitInput)
    if (isTuiAgent(agent) && normalizedSubmitInput) {
      normalized[agent] = normalizedSubmitInput
    }
  }
  return normalized
}

export function resolveAgentPostPasteSubmitInput(
  agent: TuiAgent | undefined,
  configuredInputs: Partial<Record<TuiAgent, AgentPostPasteSubmitInput>> | null | undefined
): AgentPostPasteSubmitInput {
  if (agent && configuredInputs && Object.hasOwn(configuredInputs, agent)) {
    return normalizeAgentPostPasteSubmitInput(configuredInputs[agent]) ?? 'enter'
  }
  return 'enter'
}

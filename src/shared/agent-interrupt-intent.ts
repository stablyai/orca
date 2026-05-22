import type { AgentType } from './agent-status-types'

export type AgentInterruptInputIntent = 'plain-escape' | 'ctrl-c'

export const AGENT_INTERRUPT_SETTLE_MS = 500

export type AgentInterruptInferenceRequest = {
  paneKey: string
  baselineUpdatedAt: number
  baselineStateStartedAt: number
  baselinePrompt: string
  baselineAgentType: AgentType | undefined
  intent: AgentInterruptInputIntent
  inputCount?: number
}

export function isAgentInterruptInputIntent(intent: unknown): intent is AgentInterruptInputIntent {
  return intent === 'plain-escape' || intent === 'ctrl-c'
}

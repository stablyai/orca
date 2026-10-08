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

// Ctrl+C can copy text or leave a Codex side chat without cancelling the main turn.
export function shouldIgnoreInterruptIntent(
  agentType: AgentType | undefined,
  intent: AgentInterruptInputIntent
): boolean {
  return intent === 'ctrl-c' && (agentType === 'codex' || agentType === 'droid')
}

// Escape also closes views (including Codex search and /permissions); only provider evidence ends the turn.
const ESCAPE_ALSO_NAVIGATES_AGENT_TYPES: ReadonlySet<AgentType> = new Set([
  'claude',
  'codex',
  'omp',
  'pi',
  'prime-agent'
])

/** True when this keypress is one of those TUIs' navigation Escape, and so proves nothing. */
export function isNavigationEscapeIntent(
  agentType: AgentType | undefined,
  intent: AgentInterruptInputIntent
): boolean {
  return (
    intent === 'plain-escape' &&
    agentType !== undefined &&
    ESCAPE_ALSO_NAVIGATES_AGENT_TYPES.has(agentType)
  )
}

// Why: these TUIs spend the first Escape on a cancel that can leave the turn running —
// opencode2 also dismisses its Subagents dock with it — so only the second Escape on the
// same turn is evidence of an interrupt. Shared so the renderer gate and the server
// re-check cannot drift apart.
const DOUBLE_ESCAPE_INTERRUPT_AGENT_TYPES: ReadonlySet<AgentType> = new Set([
  'opencode',
  'opencode2',
  'copilot'
])

/** True when this agent only yields an interrupt on a second same-turn Escape. */
export function requiresDoubleEscapeInterrupt(
  agentType: AgentType | undefined,
  intent: AgentInterruptInputIntent
): boolean {
  return (
    intent === 'plain-escape' &&
    agentType !== undefined &&
    DOUBLE_ESCAPE_INTERRUPT_AGENT_TYPES.has(agentType)
  )
}

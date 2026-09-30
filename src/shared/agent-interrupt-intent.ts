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

// Why: these TUIs also close an overlay on a bare Escape (Claude's /btw composer, OMP/Pi's
// focused-child and settings views). The keypress is ambiguous at the source and nothing outside
// the TUI can disambiguate it, so it is never evidence a turn ended — only the provider's own
// hook may retire the row (#13547, #9208). Ctrl+C is unaffected; it has no navigation meaning.
const ESCAPE_ALSO_NAVIGATES_AGENT_TYPES: ReadonlySet<AgentType> = new Set([
  'claude',
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

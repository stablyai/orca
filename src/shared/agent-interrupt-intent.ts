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

// Why: Codex reports its own cancel (its Interrupt hook, backed by the `turn_aborted` it writes to
// its rollout), and no key it receives proves one: Ctrl+C with a draft only clears the draft,
// Esc with a popup open only closes it, and in shared-server mode Ctrl+C opens a chooser whose
// "Run in background" cancels nothing.
const PROVIDER_REPORTS_CANCEL_AGENT_TYPES: ReadonlySet<AgentType> = new Set(['codex'])

/** True when this keypress proves nothing about whether the turn ended, so only the provider's
 *  own report may end it: a navigation Escape in the TUIs above, or any key for Codex. */
export function isInconclusiveInterruptIntent(
  agentType: AgentType | undefined,
  intent: AgentInterruptInputIntent
): boolean {
  if (agentType === undefined) {
    return false
  }
  return (
    PROVIDER_REPORTS_CANCEL_AGENT_TYPES.has(agentType) ||
    (intent === 'plain-escape' && ESCAPE_ALSO_NAVIGATES_AGENT_TYPES.has(agentType))
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

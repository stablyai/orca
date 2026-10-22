// A prompt hook that blocked or stopped the user's message: one row in the hook's own reason,
// written the same way for every agent, which the fold never hides.

import type { AgentJournalPlainStatusItem } from './agent-session-journal-types'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from './agent-session-turn-notice'

export type AgentSessionHookOutcome = 'blocked' | 'stopped'

export function hookOutcomeRowBody(
  outcome: AgentSessionHookOutcome,
  details: readonly string[]
): AgentJournalPlainStatusItem {
  const header = outcome === 'blocked' ? 'Blocked by hook' : 'Hook stopped'
  const lines = details.map((detail) => detail.trim()).filter((detail) => detail.length > 0)
  return {
    kind: 'status',
    tone: 'warning',
    presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    text:
      lines.length === 0
        ? `${header}.`
        : lines.length === 1
          ? `${header}: ${lines[0]}`
          : [header, ...lines].join('\n')
  }
}

// Keep hook outcomes as visible rows using the hook's reason, consistently across agents.

import type { AgentJournalPlainStatusItem } from './agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from './agent-session-turn-notice'

/** A Stop hook sent the agent back to work, so the reply before this row was an answer. */
export const AGENT_SESSION_HOOK_SENT_BACK_PRESENTATION = 'hook-sent-back'

export type AgentSessionHookOutcome = 'blocked' | 'stopped' | 'sent-back'

const HOOK_OUTCOME_HEADERS: Record<AgentSessionHookOutcome, string> = {
  blocked: 'Blocked by hook',
  stopped: 'Hook stopped',
  'sent-back': 'Stop hook feedback'
}

export function hookOutcomeRowBody(
  outcome: AgentSessionHookOutcome,
  details: readonly string[]
): AgentJournalPlainStatusItem {
  const header = HOOK_OUTCOME_HEADERS[outcome]
  const lines = details.map((detail) => detail.trim()).filter((detail) => detail.length > 0)
  return {
    kind: 'status',
    tone: 'warning',
    presentation:
      outcome === 'sent-back'
        ? AGENT_SESSION_HOOK_SENT_BACK_PRESENTATION
        : AGENT_SESSION_TURN_NOTICE_PRESENTATION,
    text:
      lines.length === 0
        ? `${header}.`
        : lines.length === 1
          ? `${header}: ${lines[0]}`
          : [header, ...lines].join('\n')
  }
}

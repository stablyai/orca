// Keep hook outcomes as visible rows using the hook's reason, consistently across agents.

import type { AgentJournalPlainStatusItem } from './agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from './agent-session-turn-notice'

/** A Stop hook sent the agent back to work, so the reply before this row was an answer. */
export const AGENT_SESSION_HOOK_SENT_BACK_PRESENTATION = 'hook-sent-back'

export type AgentSessionHookOutcome = 'blocked' | 'stopped' | 'sent-back'

const HOOK_OUTCOME_ROWS: Record<AgentSessionHookOutcome, { header: string; presentation: string }> =
  {
    blocked: { header: 'Blocked by hook', presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION },
    stopped: { header: 'Hook stopped', presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION },
    'sent-back': {
      header: 'Stop hook feedback',
      presentation: AGENT_SESSION_HOOK_SENT_BACK_PRESENTATION
    }
  }

export function hookOutcomeRowBody(
  outcome: AgentSessionHookOutcome,
  details: readonly string[]
): AgentJournalPlainStatusItem {
  const { header, presentation } = HOOK_OUTCOME_ROWS[outcome]
  const lines = details.map((detail) => detail.trim()).filter((detail) => detail.length > 0)
  return {
    kind: 'status',
    tone: 'warning',
    presentation,
    text:
      lines.length === 0
        ? `${header}.`
        : lines.length === 1
          ? `${header}: ${lines[0]}`
          : [header, ...lines].join('\n')
  }
}

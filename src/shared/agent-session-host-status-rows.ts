// Keep English text for legacy clients and presentation keys for translated host status rows.

import type { AgentJournalPlainStatusItem } from './agent-session-journal-types'

export const AGENT_SESSION_HOST_STATUS_COPY = {
  /** A repair skipped rows it could not read. */
  'history-repaired': "Part of this chat's history couldn't be loaded.",
  /** In place of an item too large for any history page. */
  'history-item-too-large': 'This part of the chat was too large to show.',
  /** Before turns the agent's own history has that were made outside this chat. */
  'continued-outside': 'Continued outside this chat.',
  /** The same, when replies above were dropped from the agent's history elsewhere. */
  'continued-outside-rewound':
    "Continued outside this chat. Earlier replies above are no longer in this conversation's history."
} as const

export type AgentSessionHostStatusPresentation = keyof typeof AGENT_SESSION_HOST_STATUS_COPY

export function agentSessionHostStatusBody(
  presentation: AgentSessionHostStatusPresentation
): AgentJournalPlainStatusItem {
  return { kind: 'status', text: AGENT_SESSION_HOST_STATUS_COPY[presentation], presentation }
}

export function isAgentSessionHostStatusPresentation(
  presentation: string | undefined
): presentation is AgentSessionHostStatusPresentation {
  return presentation !== undefined && Object.hasOwn(AGENT_SESSION_HOST_STATUS_COPY, presentation)
}

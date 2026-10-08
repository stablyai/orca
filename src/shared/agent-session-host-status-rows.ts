// Status rows a host writes in its own words. Each names itself with a presentation so a client can
// say it in the reader's language; its `text` stays the words for a client that can't.

import type { AgentJournalPlainStatusItem } from './agent-session-journal-types'

export const AGENT_SESSION_HOST_STATUS_COPY = {
  /** A repair skipped rows it could not read. */
  'history-repaired': "Part of this chat's history couldn't be loaded.",
  /** In place of an item too large for any history page. */
  'history-item-too-large': 'This part of the chat was too large to show.',
  /** A turn cut short with nobody asking (a crash, quit, restart or eviction, or an agent exit whose
   *  own settle failed), worded for every cause because a reader can't tell them apart. */
  'response-interrupted': 'This response was interrupted. You can continue in this conversation.',
  /** A host's row about Orca stopping under a turn (a quit, an update, a crash), which names its
   *  cause in `orcaStop`; worded so only where the reader can't name the machine. */
  'orca-stop': 'This response was interrupted. You can continue in this conversation.'
} as const

export type AgentSessionHostStatusPresentation = keyof typeof AGENT_SESSION_HOST_STATUS_COPY

export function agentSessionHostStatusBody(
  presentation: AgentSessionHostStatusPresentation
): AgentJournalPlainStatusItem {
  return { kind: 'status', text: AGENT_SESSION_HOST_STATUS_COPY[presentation], presentation }
}

/** The row that explains a turn cut short with nobody asking. Muted, not an error: the turn was
 *  interrupted, and `notice` is the tone a client that can't name the presentation draws it in. */
export function agentSessionResponseInterruptedBody(): AgentJournalPlainStatusItem {
  return { ...agentSessionHostStatusBody('response-interrupted'), tone: 'notice' }
}

/** The same row as a host stores it: red, because a client older than the presentation folds every
 *  row but an error one under a collapsed turn. A client that knows the presentation mutes it. */
export function agentSessionResponseInterruptedStoredBody(): AgentJournalPlainStatusItem {
  return { ...agentSessionHostStatusBody('response-interrupted'), tone: 'error' }
}

/** A row that says a turn was cut short: muted, never folded with the turn's work, and never a
 *  failure report, whatever tone an older reader needs it to carry. */
export function isAgentSessionInterruptionPresentation(presentation: string | undefined): boolean {
  return presentation === 'response-interrupted' || presentation === 'orca-stop'
}

export function isAgentSessionHostStatusPresentation(
  presentation: string | undefined
): presentation is AgentSessionHostStatusPresentation {
  return presentation !== undefined && Object.hasOwn(AGENT_SESSION_HOST_STATUS_COPY, presentation)
}

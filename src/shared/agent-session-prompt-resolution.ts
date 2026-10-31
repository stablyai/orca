import type { AgentSessionFormContent } from './agent-session-form'
import type { AgentSessionQuestionAnswer } from './agent-session-question-answer'

export const AGENT_JOURNAL_RESOLUTION_STATES = ['pending', 'resolved', 'cancelled'] as const
export type AgentJournalResolutionState = (typeof AGENT_JOURNAL_RESOLUTION_STATES)[number]

/** Durable resolution uses compare-and-set so competing clients cannot invoke the provider callback twice. */
export type AgentJournalResolution = {
  state: AgentJournalResolutionState
  /** Option id the winner picked; null while pending or cancelled. For a question, the answer in the
   *  packed form older clients read; `answers` is the same answer structured. */
  selectedOptionId: string | null
  /** Question answers. Absent on approvals and on rows written before hosts recorded it. */
  formContent?: AgentSessionFormContent
  answers?: AgentSessionQuestionAnswer[]
  /** Opaque client identity of the resolver, for "answered on <device>". */
  resolvedBy: string | null
  resolvedAt: number | null
}

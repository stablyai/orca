import type { AgentJournalSubmissionFields } from './agent-session-journal-types'

declare const submissionRecordKind: unique symbol

/** Host time when the provider confirmed receipt of a pending send, clearing “Sending…”. */
export type AgentJournalSubmission = AgentJournalSubmissionFields & {
  writtenAt?: number
  readonly [submissionRecordKind]?: 'journal'
}

/** The reducer strips receipts at intake. The type brand prevents accidental reassignment. */
export type StructuredAgentSubmission = AgentJournalSubmissionFields & {
  readonly [submissionRecordKind]?: 'client'
}

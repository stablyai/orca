import type { AgentJournalBoundedPayload } from './agent-session-journal-types'

export type AgentJournalDiffItem = {
  kind: 'diff'
  state?: string
  path: string
  patch: AgentJournalBoundedPayload
}

import type {
  AgentJournalPromptOption,
  AgentJournalResolution
} from './agent-session-journal-types'

/** What every approval and question carries: its choices, the request it stands for, and its answer. */
export type AgentJournalPromptFields = {
  options: AgentJournalPromptOption[]
  /** Digest of the provider's full request, without request ids; matches the same request re-asked. */
  requestDigest?: string
  resolution: AgentJournalResolution
}

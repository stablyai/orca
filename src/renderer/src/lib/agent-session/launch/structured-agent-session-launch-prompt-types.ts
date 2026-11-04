import type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-callers'
import type { AgentJournalSkillRef } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

export type { StructuredPromptDeliveryResult } from './structured-agent-session-launch-callers'

export type StructuredLaunchPromptOptions = {
  prompt?: string
  skills?: readonly AgentJournalSkillRef[]
  promptDelivery?: 'auto-submit' | 'submit-after-ready' | 'draft'
  onPromptDelivered?: () => void
}

export type StagedDelivery = Omit<
  StructuredPromptDeliveryResult,
  'inComposer' | 'failureNotified'
> & {
  inComposer: boolean
  failureNotified?: boolean
}

import { sayAgentSessionFailureTranslated } from './agent-session-failure-words-text'
import { agentSessionWriteNoticeText } from './agent-session-write-notice-text'
import { createStructuredConversationCommandRunner } from '../../../../shared/structured-conversation-command-send'

export type { StructuredConversationCommandCauses } from '../../../../shared/structured-conversation-command-send'

export const { sendStructuredConversationCommand, structuredConversationCommandRunner } =
  createStructuredConversationCommandRunner({
    noticeText: agentSessionWriteNoticeText,
    sayFailure: sayAgentSessionFailureTranslated
  })

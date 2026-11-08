import { z } from 'zod'
import { NativeChatSession } from './native-chat-params'
import { JournalCursor, SessionId } from './structured-agent-session-params'

export const StructuredChatSubmissionSummary = z
  .object({
    sessionId: SessionId,
    before: JournalCursor
  })
  .strict()

export const PtyChatSubmissionSummary = NativeChatSession.pick({
  agent: true,
  sessionId: true,
  transcriptPath: true
})
  .extend({ anchorId: z.string().min(1) })
  .strict()

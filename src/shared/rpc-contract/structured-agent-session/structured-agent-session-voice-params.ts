import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'
import {
  AGENT_SESSION_VOICE_NAME_PATTERN,
  AGENT_SESSION_VOICE_OFFER_MAX_LENGTH
} from '../../agent-session/agent-session-voice-conversation'

export const VoiceConversationParams = z
  .object({
    sessionId: SessionId,
    offerSdp: z.string().min(1).max(AGENT_SESSION_VOICE_OFFER_MAX_LENGTH),
    /** Absent: Codex picks its configured or built-in voice. */
    voice: z.string().regex(AGENT_SESSION_VOICE_NAME_PATTERN).optional()
  })
  .strict()

export const CodexVoicesParams = z.object({ sessionId: SessionId }).strict()

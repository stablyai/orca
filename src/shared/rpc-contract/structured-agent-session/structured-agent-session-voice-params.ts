import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'
import { AGENT_SESSION_VOICE_OFFER_MAX_LENGTH } from '../../agent-session/agent-session-voice-conversation'

export const VoiceConversationParams = z
  .object({
    sessionId: SessionId,
    offerSdp: z.string().min(1).max(AGENT_SESSION_VOICE_OFFER_MAX_LENGTH)
  })
  .strict()

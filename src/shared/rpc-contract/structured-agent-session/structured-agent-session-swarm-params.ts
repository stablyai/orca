import * as z from 'zod'
import { SessionId } from './structured-agent-session-identifiers'

export const AgentSessionSwarmReadParams = z
  .object({
    sessionId: SessionId,
    ifNoneMatch: z.string().max(1024).optional()
  })
  .strict()

export const AgentSessionSwarmTranscriptParams = z
  .object({
    sessionId: SessionId,
    conversationId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,128}$/, 'Invalid Antigravity conversation id'),
    maxEntries: z.number().int().min(1).max(1000).optional()
  })
  .strict()

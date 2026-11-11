import { z } from 'zod'
import { SessionId } from './structured-agent-session-identifiers'

const ServerName = z
  .string()
  .min(1)
  .max(512)
  .refine((name) =>
    [...name].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
  )

export const AgentSessionMcpParams = z
  .object({
    sessionId: SessionId,
    operation: z.discriminatedUnion('action', [
      z.object({ action: z.literal('status') }).strict(),
      z.object({ action: z.literal('authenticate'), server: ServerName }).strict(),
      z.object({ action: z.literal('reconnect'), server: ServerName }).strict(),
      z.object({ action: z.literal('toggle'), server: ServerName, enabled: z.boolean() }).strict()
    ])
  })
  .strict()

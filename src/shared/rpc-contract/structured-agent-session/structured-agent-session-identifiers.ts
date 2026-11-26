import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { isAgentSessionId } from '../../agent-session/lifecycle/agent-session-record'
import { AGENT_SESSION_ID_MAX_LENGTH as MAX_ID_LENGTH } from '../../agent-session/agent-session-wire'

export const SessionId = lazyZodSchema(() =>
  z.string().max(MAX_ID_LENGTH).refine(isAgentSessionId, 'Invalid agent session id')
)

export const Identifier = (message: string, maxLength = MAX_ID_LENGTH) =>
  z
    .string()
    .min(1, message)
    .max(maxLength, message)
    .refine((value) => value === value.trim(), message)

export const JournalCursor = lazyZodSchema(() =>
  z
    .object({
      epoch: Identifier('Invalid journal epoch'),
      sequence: z.number().int().nonnegative()
    })
    .strict()
)

export const ContinuationContextParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId,
      workspaceId: Identifier('Invalid workspace id'),
      expectedCursor: JournalCursor
    })
    .strict()
)

// Identity, cursor and mutation fences shared by structured session RPC schemas.
import { z } from 'zod'
import { isAgentSessionId } from '../agent-session-record'
import { AGENT_SESSION_ID_MAX_LENGTH } from '../agent-session-wire'

export const MAX_ID_LENGTH = AGENT_SESSION_ID_MAX_LENGTH

export const SessionId = z
  .string()
  .max(MAX_ID_LENGTH)
  .refine(isAgentSessionId, 'Invalid agent session id')

export const Identifier = (message: string, maxLength = MAX_ID_LENGTH) =>
  z
    .string()
    .min(1, message)
    .max(maxLength, message)
    .refine((value) => value === value.trim(), message)

export const JournalCursor = z
  .object({
    epoch: Identifier('Invalid journal epoch'),
    sequence: z.number().int().nonnegative()
  })
  .strict()

export const MutationEnvelope = z
  .object({
    sessionId: SessionId,
    clientOperationId: Identifier('Invalid client operation id'),
    /** Null is the "must not exist yet" case; every other call fences. */
    expectedRuntimeFence: z.number().int().positive().nullable(),
    payloadFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'Payload fingerprint must be a sha256 hex digest')
  })
  .strict()

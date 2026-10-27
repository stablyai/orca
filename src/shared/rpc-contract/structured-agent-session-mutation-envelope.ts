import { Identifier, SessionId } from './structured-agent-session-identifiers'
import { z } from 'zod'

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

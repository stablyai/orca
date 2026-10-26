import { z } from 'zod'
import { MutationEnvelope } from './structured-agent-session-params'
import { Identifier, SessionId } from './structured-agent-session-identifiers'
export const RewindParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id', 4096),
    expectedEpoch: Identifier('Invalid journal epoch'),
    mode: z.enum(['conversation', 'conversation-and-files']).optional(),
    filesFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
  })
  .strict()

export const RewindFilesPreviewParams = z
  .object({
    sessionId: SessionId,
    itemId: Identifier('Invalid item id', 4096),
    expectedEpoch: Identifier('Invalid journal epoch')
  })
  .strict()

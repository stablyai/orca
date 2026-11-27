import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

const SessionId = () => z.string().regex(/^[A-Za-z0-9_-]{8,128}$/)

/** Copies `sourceSessionId`'s conversation into the new chat `sessionId`, another vendor's agent. */
export const CrossVendorHandoffParams = lazyZodSchema(() =>
  z
    .object({
      sessionId: SessionId(),
      sourceSessionId: SessionId()
    })
    .strict()
)

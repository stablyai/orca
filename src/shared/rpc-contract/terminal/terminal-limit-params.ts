import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { MAX_CONFIGURED_TERMINALS } from '../../terminal/runtime-policy/terminal-limit-policy'

export const TerminalLimitUpdateParams = lazyZodSchema(() =>
  z.object({
    maxTerminals: z.number().int().min(1).max(MAX_CONFIGURED_TERMINALS),
    daemonNonce: z.string().min(1).max(128)
  })
)

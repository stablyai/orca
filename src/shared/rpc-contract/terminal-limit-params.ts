import { z } from 'zod'
import { MAX_CONFIGURED_TERMINALS } from '../terminal-limit-policy'

export const TerminalLimitUpdateParams = z.object({
  maxTerminals: z.number().int().min(1).max(MAX_CONFIGURED_TERMINALS),
  daemonNonce: z.string().min(1).max(128)
})

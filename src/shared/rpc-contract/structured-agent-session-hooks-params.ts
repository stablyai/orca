import { z } from 'zod'
import { OptionsParams } from './structured-agent-session-params'

export const HooksParams = OptionsParams.extend({
  trust: z
    .object({
      scope: z.string().length(64),
      key: z.string().min(1).max(8192),
      currentHash: z.string().min(1).max(1024)
    })
    .strict()
    .optional()
}).strict()

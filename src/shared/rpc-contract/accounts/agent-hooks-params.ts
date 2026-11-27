import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const PrepareCodexForWslPaneParams = lazyZodSchema(() =>
  z
    .object({
      codexHome: z.string().max(4_096),
      orcaCodexHome: z.string().max(4_096),
      wslDistro: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .regex(/^[^\\/\r\n]+$/)
    })
    .strict()
)

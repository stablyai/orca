import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString } from '../rpc-param-primitives'

export const RequestShowParams = lazyZodSchema(() =>
  z.object({
    request: requiredString('Missing --request'),
    // The paired server a forwarded request ran on; its receipt is kept there.
    on: z.string().min(1).optional()
  })
)

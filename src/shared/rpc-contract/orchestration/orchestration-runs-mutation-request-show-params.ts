import { z } from 'zod'
import { requiredString } from '../rpc-param-primitives'

export const RequestShowParams = z.object({
  request: requiredString('Missing --request'),
  // The paired server a forwarded request ran on; its receipt is kept there.
  on: z.string().min(1).optional()
})

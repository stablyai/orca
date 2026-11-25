import { z } from 'zod'
import { requiredString } from '../rpc-param-primitives'

export const WorkerAcknowledgeParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  acknowledged: z.boolean().default(true)
})

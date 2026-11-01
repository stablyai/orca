import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

export const DispatchRebindParams = z.object({
  dispatch: requiredString('Missing --dispatch'),
  to: requiredString('Missing --to')
})

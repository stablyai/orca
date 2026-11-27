import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString } from '../rpc-param-primitives'

export const WorkerDispatchParams = lazyZodSchema(() =>
  z.object({ dispatch: requiredString('Missing --dispatch') })
)

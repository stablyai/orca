import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'

export const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

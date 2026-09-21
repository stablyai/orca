import { z } from 'zod'
import {
  OptionalFiniteNumber,
  PayloadDigest,
  PayloadReadLimit,
  PayloadReadOffset,
  requiredString
} from './rpc-param-primitives'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../orchestration-worker-output'

export const WorkerDispatchParams = z.object({ dispatch: requiredString('Missing --dispatch') })

export const WorkerReadParams = WorkerDispatchParams.extend({
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber,
  source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
})

export const WorkerPayloadReadParams = WorkerDispatchParams.extend({
  digest: PayloadDigest,
  offset: PayloadReadOffset,
  limit: PayloadReadLimit
})

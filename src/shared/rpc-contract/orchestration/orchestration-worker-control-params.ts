import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalFiniteNumber, requiredString } from '../rpc-param-primitives'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../orchestration/workers/orchestration-worker-output'

export const WorkerDispatchParams = lazyZodSchema(() =>
  z.object({ dispatch: requiredString('Missing --dispatch') })
)

export const WorkerReadParams = lazyZodSchema(() =>
  WorkerDispatchParams.extend({
    cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
    limit: OptionalFiniteNumber,
    source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
  })
)

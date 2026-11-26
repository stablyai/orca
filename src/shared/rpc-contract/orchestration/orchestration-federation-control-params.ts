import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalFiniteNumber, requiredString } from '../rpc-param-primitives'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../../orchestration/workers/orchestration-worker-output'

export const FederationDispatchParams = lazyZodSchema(() =>
  z.object({
    dispatchId: requiredString('Missing Dispatch ID')
  })
)

export const FederationReadParams = lazyZodSchema(() =>
  FederationDispatchParams.extend({
    cursor: OptionalFiniteNumber,
    limit: OptionalFiniteNumber
  })
)

export const FederationOutputReadParams = lazyZodSchema(() =>
  FederationDispatchParams.extend({
    cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
    limit: OptionalFiniteNumber,
    source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
  })
)

export const FederationFleetSnapshotParams = lazyZodSchema(() =>
  z.object({
    dispatchIds: z.array(requiredString('Missing Dispatch ID')).min(1).max(100)
  })
)

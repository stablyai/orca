import { z } from 'zod'
import { OptionalFiniteNumber, requiredString } from './rpc-param-primitives'
import { ORCHESTRATION_WORKER_READ_SOURCES } from '../orchestration-worker-output'

export const FederationDispatchParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID')
})

export const FederationReadParams = FederationDispatchParams.extend({
  cursor: OptionalFiniteNumber,
  limit: OptionalFiniteNumber
})

export const FederationOutputReadParams = FederationDispatchParams.extend({
  cursor: z.union([z.number().int().nonnegative(), z.string().min(1).max(2_048)]).optional(),
  limit: OptionalFiniteNumber,
  source: z.enum(ORCHESTRATION_WORKER_READ_SOURCES).optional()
})

export const FederationFleetSnapshotParams = z.object({
  dispatchIds: z.array(requiredString('Missing Dispatch ID')).min(1).max(100)
})

export const FederationPayloadReadParams = FederationDispatchParams.extend({
  digest: z.string().regex(/^[0-9a-f]{64}$/, 'Payload digest must be a lowercase sha256 hex digest'),
  offset: z.number().int().nonnegative().optional(),
  limit: OptionalFiniteNumber
})

import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { requiredString } from '../rpc-param-primitives'
import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../orchestration/fleet/orchestration-fleet-projection'

export const WorkerDispatchParams = lazyZodSchema(() =>
  z.object({ dispatch: requiredString('Missing --dispatch') })
)

export const WorkerRetainParams = lazyZodSchema(() => WorkerDispatchParams.strict())

export const WORKER_TERMINAL_LIST_STATES = [
  'active',
  'reclaimable',
  'retained',
  'release_pending',
  'release_unknown',
  'released'
] as const

export const WorkerListParams = lazyZodSchema(() =>
  z.object({
    run: z.string().min(1).optional(),
    terminalState: z.enum(WORKER_TERMINAL_LIST_STATES).optional(),
    cursor: z.string().min(1).max(2_048).optional(),
    limit: z.number().int().min(1).max(ORCHESTRATION_FLEET_PAGE_MAX).optional(),
    includeRemote: z.boolean().optional(),
    paginate: z.boolean().optional(),
    // A paired server's own list, paged by its cursor.
    on: z.string().min(1).optional()
  })
)

/** A native chat's own Orca session id: the workers it started. */
export const SessionWorkersParams = lazyZodSchema(() =>
  z.object({ session: requiredString('Missing --session') })
)

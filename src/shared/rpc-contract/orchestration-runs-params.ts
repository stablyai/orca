import { z } from 'zod'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../orchestration/orchestration-run-pagination'
import { MESSAGE_TYPES } from '../orchestration/orchestration-message-types'

const NotifyTypes = z.array(z.enum(MESSAGE_TYPES))

export const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: requiredString('Missing coordinator terminal'),
  /** Message types allowed to wake the coordinator; omitted wakes for every type. */
  notifyTypes: NotifyTypes.optional()
})

export const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  /** Replaces the Run's wake allow-list; undefined keeps it and null restores every type. */
  notifyTypes: NotifyTypes.nullable().optional(),
  takeoverLegacy: OptionalBoolean
})

export const RunCurrentParams = z.object({ from: requiredString('Missing coordinator terminal') })

export const RunListParams = z.object({
  limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
  cursor: z.string().min(1).optional()
})

export const RunShowParams = z.object({
  id: requiredString('Missing --id'),
  from: OptionalString,
  // Lists removed work 200 entries per page; older hosts strip both and return no removedWork.
  removed: OptionalBoolean,
  cursor: z.string().min(1).optional()
})

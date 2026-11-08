import { z } from 'zod'
import { OptionalBoolean, OptionalString, requiredString } from './rpc-param-primitives'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../orchestration/orchestration-run-pagination'

// An external coordinator names no terminal; the dispatcher binds it to its paired client instead.
export const RunCreateParams = z.object({
  objective: requiredString('Missing --objective'),
  from: OptionalString,
  external: OptionalBoolean
})

export const RunUseParams = z.object({
  id: requiredString('Missing --id'),
  from: requiredString('Missing coordinator terminal'),
  takeoverLegacy: OptionalBoolean
})

export const RunCurrentParams = z.object({ from: OptionalString })

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

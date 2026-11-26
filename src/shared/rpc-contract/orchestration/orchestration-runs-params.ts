import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalBoolean, OptionalString, requiredString } from '../rpc-param-primitives'
import { ORCHESTRATION_RUN_PAGE_LIMIT } from '../../orchestration/orchestration-run-pagination'

export const RunCreateParams = lazyZodSchema(() =>
  z.object({
    objective: requiredString('Missing --objective'),
    from: requiredString('Missing coordinator terminal')
  })
)

export const RunUseParams = lazyZodSchema(() =>
  z.object({
    id: requiredString('Missing --id'),
    from: requiredString('Missing coordinator terminal'),
    takeoverLegacy: OptionalBoolean
  })
)

export const RunCurrentParams = lazyZodSchema(() =>
  z.object({ from: requiredString('Missing coordinator terminal') })
)

export const RunListParams = lazyZodSchema(() =>
  z.object({
    limit: z.number().int().min(1).max(ORCHESTRATION_RUN_PAGE_LIMIT).optional(),
    cursor: z.string().min(1).optional()
  })
)

export const RunShowParams = lazyZodSchema(() =>
  z.object({
    id: requiredString('Missing --id'),
    from: OptionalString,
    // Lists removed work 200 entries per page; older hosts strip both and return no removedWork.
    removed: OptionalBoolean,
    cursor: z.string().min(1).optional()
  })
)

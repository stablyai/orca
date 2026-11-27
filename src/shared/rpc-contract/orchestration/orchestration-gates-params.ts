import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalFiniteNumber, OptionalString, requiredString } from '../rpc-param-primitives'

export const RunParams = lazyZodSchema(() =>
  z.object({
    spec: requiredString('Missing --spec'),
    from: OptionalString,
    pollIntervalMs: OptionalFiniteNumber,
    maxConcurrent: OptionalFiniteNumber,
    worktree: OptionalString
  })
)

export const RunStopParams = lazyZodSchema(() => z.object({}))

export const GateCreateParams = lazyZodSchema(() =>
  z.object({
    task: requiredString('Missing --task'),
    question: requiredString('Missing --question'),
    options: OptionalString,
    from: OptionalString,
    run: OptionalString
  })
)

export const GateResolveParams = lazyZodSchema(() =>
  z.object({
    id: requiredString('Missing --id'),
    resolution: requiredString('Missing --resolution'),
    from: OptionalString,
    run: OptionalString
  })
)

export const GateListParams = lazyZodSchema(() =>
  z.object({
    task: OptionalString,
    status: z.enum(['pending', 'resolved', 'timeout']).optional(),
    from: OptionalString,
    run: OptionalString
  })
)

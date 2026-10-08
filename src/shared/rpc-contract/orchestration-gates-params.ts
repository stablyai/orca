import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredString } from './rpc-param-primitives'

export const RunParams = z.object({
  spec: requiredString('Missing --spec'),
  from: OptionalString,
  pollIntervalMs: OptionalFiniteNumber,
  maxConcurrent: OptionalFiniteNumber,
  worktree: OptionalString
})

export const RunStopParams = z.object({})

export const GateCreateParams = z.object({
  task: requiredString('Missing --task'),
  question: requiredString('Missing --question'),
  options: OptionalString,
  from: OptionalString,
  run: OptionalString
})

export const GateResolveParams = z.object({
  id: requiredString('Missing --id'),
  resolution: requiredString('Missing --resolution'),
  from: OptionalString,
  run: OptionalString
})

export const GateListParams = z.object({
  task: OptionalString,
  status: z.enum(['pending', 'resolved', 'timeout']).optional(),
  from: OptionalString,
  run: OptionalString
})

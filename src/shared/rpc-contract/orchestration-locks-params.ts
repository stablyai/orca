import { z } from 'zod'
import {
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalString,
  requiredString
} from './rpc-param-primitives'

export const LockAcquireParams = z.object({
  resource: requiredString('Missing --resource'),
  reason: OptionalString,
  ttlMs: OptionalFiniteNumber,
  wait: OptionalBoolean,
  timeoutMs: OptionalFiniteNumber,
  from: OptionalString
})

export const LockReleaseParams = z.object({
  resource: requiredString('Missing --resource'),
  force: OptionalBoolean,
  from: OptionalString
})

export const LockListParams = z.object({
  resource: OptionalString
})

export const BoardPostParams = z.object({
  title: requiredString('Missing --title'),
  body: OptionalString,
  kind: z.enum(['announcement', 'task', 'handoff']).optional(),
  scope: OptionalString,
  assignee: OptionalString,
  from: OptionalString
})

export const BoardClaimParams = z.object({
  id: requiredString('Missing --id'),
  status: z.enum(['claimed', 'completed']).optional(),
  from: OptionalString
})

export const BoardListParams = z.object({
  scope: OptionalString,
  kind: z.enum(['announcement', 'task', 'handoff']).optional(),
  status: z.enum(['open', 'claimed', 'completed']).optional(),
  limit: OptionalFiniteNumber
})

import { z } from 'zod'
import { OptionalFiniteNumber, requiredString } from './rpc-param-primitives'

export const FederationPullParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  afterSequence: OptionalFiniteNumber,
  replayUnacknowledged: z.boolean().optional(),
  limit: OptionalFiniteNumber
})

export const FederationAckParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  throughSequence: z.number().int().nonnegative(),
  settlements: z
    .array(
      z.object({
        sequence: z.number().int().positive(),
        lifecycle: z.discriminatedUnion('action', [
          z.object({
            action: z.enum(['completed', 'failed']),
            authority: z.literal('run_home')
          }),
          z.object({
            action: z.literal('rejected'),
            code: z.string(),
            reason: z.string(),
            authority: z.literal('run_home')
          })
        ])
      })
    )
    .optional()
})

export const FederationImportParams = z.object({
  dispatchId: requiredString('Missing Dispatch ID'),
  items: z.array(
    z.object({
      dispatch_id: requiredString('Missing item Dispatch ID'),
      direction: z.literal('to_worker'),
      sequence: z.number().int().positive(),
      message_id: requiredString('Missing relay message ID'),
      kind: requiredString('Missing relay kind'),
      payload: requiredString('Missing relay payload')
    })
  )
})

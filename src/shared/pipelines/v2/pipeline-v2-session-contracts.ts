import * as z from 'zod'
import { pipelineV2Id, pipelineV2Text } from './pipeline-v2-values'
import { PipelineV2InvocationReceipt } from './pipeline-v2-results'

export const PipelineV2BoundSessionAddress = z
  .object({
    requestId: pipelineV2Id,
    sessionId: pipelineV2Id.optional(),
    ptyId: pipelineV2Id.optional()
  })
  .refine((value) => Boolean(value.sessionId) !== Boolean(value.ptyId), 'pipeline_session_required')

export const PipelineV2BoundSessionInput = z
  .strictObject({
    requestId: pipelineV2Id,
    sessionId: pipelineV2Id.optional(),
    ptyId: pipelineV2Id.optional(),
    message: pipelineV2Text(4000),
    hasAttachments: z.boolean()
  })
  .refine((value) => Boolean(value.sessionId) !== Boolean(value.ptyId), 'pipeline_session_required')
export type PipelineV2BoundSessionInput = z.infer<typeof PipelineV2BoundSessionInput>
export const PipelineV2BoundSessionResult = z.strictObject({
  handled: z.boolean(),
  accepted: z.boolean(),
  rejected: z.string().min(1).max(500).optional(),
  receipt: PipelineV2InvocationReceipt.optional()
})
export type PipelineV2BoundSessionResult = z.infer<typeof PipelineV2BoundSessionResult>

import * as z from 'zod'
import { PipelineV2ResponseObservation } from './pipeline-v2-response-observation'
import {
  PipelineSessionBinding,
  PipelineV2BudgetExtension,
  PipelineV2DecisionPin,
  PipelineV2Submission
} from './pipeline-v2-run-contracts'
import {
  pipelineV2Id,
  pipelineV2Digest,
  pipelineV2Revision,
  pipelineV2Source,
  pipelineV2Text
} from './pipeline-v2-values'

export const PipelineV2Command = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('reserve'),
    invocationId: pipelineV2Id,
    purpose: z.enum(['stage', 'discussion', 'synchronize']),
    sourceRevision: pipelineV2Source,
    message: pipelineV2Text(4000).optional(),
    clientPayloadDigest: pipelineV2Digest.optional(),
    pin: PipelineV2DecisionPin.optional(),
    reviewCommit: pipelineV2Source.optional()
  }),
  z.strictObject({
    kind: z.literal('bind'),
    invocationId: pipelineV2Id,
    dispatchId: pipelineV2Id,
    session: PipelineSessionBinding
  }),
  z.strictObject({
    kind: z.literal('submit'),
    invocationId: pipelineV2Id,
    dispatchId: pipelineV2Id,
    inputRevision: pipelineV2Revision,
    sourceRevision: pipelineV2Source,
    result: PipelineV2Submission
  }),
  z.strictObject({ kind: z.literal('settle'), invocationId: pipelineV2Id }),
  PipelineV2DecisionPin.extend({
    kind: z.literal('decide'),
    action: z.enum(['accept', 'rework']),
    comment: pipelineV2Text(4000).optional()
  }),
  PipelineV2BudgetExtension.extend({ kind: z.literal('extend_budget') }),
  z.strictObject({ kind: z.literal('pause'), reason: pipelineV2Text(500).optional() }),
  z.strictObject({ kind: z.literal('resume') }),
  z.strictObject({
    kind: z.literal('reconcile'),
    invocationId: pipelineV2Id,
    response: z
      .strictObject({
        sourceRevision: pipelineV2Source,
        result: PipelineV2Submission,
        observation: PipelineV2ResponseObservation
      })
      .optional()
  }),
  z.strictObject({ kind: z.literal('retry'), sourceRevision: pipelineV2Source }),
  z.strictObject({ kind: z.literal('definition_disabled') }),
  z.strictObject({ kind: z.literal('definition_enabled') }),
  z.strictObject({ kind: z.literal('uncertain'), reason: pipelineV2Text(500) }),
  z.strictObject({
    kind: z.literal('interrupted'),
    invocationId: pipelineV2Id,
    reason: pipelineV2Text(500).optional()
  }),
  z.strictObject({
    kind: z.literal('observe_response'),
    invocationId: pipelineV2Id,
    observation: PipelineV2ResponseObservation
  }),
  z.strictObject({
    kind: z.literal('launch_refused'),
    invocationId: pipelineV2Id,
    reason: pipelineV2Text(500)
  }),
  z.strictObject({ kind: z.literal('setup_ready') }),
  z.strictObject({ kind: z.literal('setup_wait'), terminalHandle: pipelineV2Id.optional() }),
  z.strictObject({
    kind: z.literal('invalidate_candidate'),
    sessionId: pipelineV2Id,
    receiptId: pipelineV2Id
  }),
  z.strictObject({ kind: z.literal('revalidate'), sourceRevision: pipelineV2Source })
])
export const PipelineV2Mutation = z.strictObject({
  requestId: pipelineV2Id,
  expectedRevision: pipelineV2Revision,
  expectedInstanceId: pipelineV2Id,
  command: PipelineV2Command
})
export type PipelineV2Command = z.infer<typeof PipelineV2Command>
export type PipelineV2Mutation = z.infer<typeof PipelineV2Mutation>

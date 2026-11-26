import * as z from 'zod'
import { PipelineV2DecisionPin } from './pipeline-v2-run-contracts'
import {
  pipelineV2Digest,
  pipelineV2Id,
  pipelineV2Revision,
  pipelineV2Text
} from './pipeline-v2-values'

export const PipelineV2DiscussionInput = z.strictObject({
  id: pipelineV2Id,
  requestId: pipelineV2Id,
  expectedRevision: pipelineV2Revision,
  expectedInstanceId: pipelineV2Id,
  pin: PipelineV2DecisionPin,
  message: pipelineV2Text(4000),
  clientPayloadDigest: pipelineV2Digest.optional()
})
export const PipelineV2SynchronizationInput = PipelineV2DiscussionInput
export type PipelineV2DiscussionInput = z.infer<typeof PipelineV2DiscussionInput>
export type PipelineV2SynchronizationInput = z.infer<typeof PipelineV2SynchronizationInput>

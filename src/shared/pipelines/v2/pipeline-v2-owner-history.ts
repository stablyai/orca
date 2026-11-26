import * as z from 'zod'
import { PipelineV2CompiledTarget } from './pipeline-v2-contracts'
import { PipelineV2EffectiveExecutor } from './pipeline-v2-run-contracts'
import {
  pipelineV2Id,
  pipelineV2Digest,
  pipelineV2Revision,
  pipelineV2Source,
  pipelineV2Text
} from './pipeline-v2-values'

export const PipelineV2OwnerDecisionRecord = z.strictObject({
  id: pipelineV2Id,
  runId: pipelineV2Id,
  requestId: pipelineV2Id,
  workspaceInstanceId: pipelineV2Id,
  visitId: pipelineV2Id,
  stageId: pipelineV2Id,
  action: z.enum(['accept', 'rework']),
  proposedOutcomeId: pipelineV2Id,
  outcomeId: pipelineV2Id.optional(),
  target: PipelineV2CompiledTarget,
  candidateId: pipelineV2Id,
  candidateDigest: pipelineV2Digest,
  sourceRevision: pipelineV2Source,
  sessionId: pipelineV2Id,
  inputRevision: pipelineV2Revision,
  discussionRevision: pipelineV2Revision,
  executor: PipelineV2EffectiveExecutor.optional(),
  comment: pipelineV2Text(4000).optional(),
  revision: pipelineV2Revision,
  sequence: pipelineV2Revision,
  createdAt: pipelineV2Revision
})
export type PipelineV2OwnerDecisionRecord = z.infer<typeof PipelineV2OwnerDecisionRecord>

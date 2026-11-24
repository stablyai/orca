import * as z from 'zod'
import {
  PipelineV2Visit,
  PipelineV2EffectiveExecutor,
  PipelineSessionBinding
} from './pipeline-v2-run-contracts'
import { PipelineV2OwnerDecisionRecord } from './pipeline-v2-owner-history'
import { pipelineV2Id, pipelineV2Revision } from './pipeline-v2-values'
import { PipelineV2CompiledTarget } from './pipeline-v2-contracts'
import { PipelineV2StageUsage } from './pipeline-v2-response-observation'

export const PipelineV2DecisionSummary = PipelineV2OwnerDecisionRecord.pick({
  action: true,
  outcomeId: true,
  target: true,
  candidateId: true,
  sessionId: true,
  sourceRevision: true
}).extend({
  artifactId: pipelineV2Id,
  commentPreview: z.string().max(200).optional(),
  commentTruncated: z.boolean()
})
export const PipelineV2VisitSummary = PipelineV2Visit.pick({
  id: true,
  stageId: true,
  attempt: true,
  state: true,
  discussionTurns: true,
  acceptedCandidateId: true
}).extend({
  candidateCount: z.number().int().min(0).max(65),
  hasOwnerComment: z.boolean(),
  decision: PipelineV2DecisionSummary.optional(),
  latestCandidateId: pipelineV2Id.optional(),
  resultPreview: z
    .strictObject({
      candidateId: pipelineV2Id,
      summary: z.string().max(320),
      truncated: z.boolean(),
      status: z.enum(['result', 'blocked']),
      checkResult: z.enum(['passed', 'failed', 'unknown']).optional(),
      reviewFindings: z.number().int().min(0).max(24).optional()
    })
    .optional(),
  executor: PipelineV2EffectiveExecutor.optional(),
  session: PipelineSessionBinding.optional(),
  outcome: z.strictObject({ id: pipelineV2Id, target: PipelineV2CompiledTarget }).optional(),
  blockReason: z.string().max(500).optional(),
  usage: z
    .strictObject({
      durationMs: z.number().nonnegative().nullable(),
      tokens: PipelineV2StageUsage.shape.tokens,
      usd: z.null(),
      invocationCount: z.number().int().nonnegative(),
      measuredInvocations: z.number().int().nonnegative()
    })
    .optional()
})
export const PipelineV2VisitPage = z.strictObject({
  runId: pipelineV2Id,
  revision: pipelineV2Revision,
  visits: z.array(PipelineV2VisitSummary).max(50),
  cursor: pipelineV2Revision,
  hasMore: z.boolean()
})
export type PipelineV2VisitSummary = z.infer<typeof PipelineV2VisitSummary>
export type PipelineV2VisitPage = z.infer<typeof PipelineV2VisitPage>

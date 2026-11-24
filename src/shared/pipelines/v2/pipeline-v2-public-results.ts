import { z } from 'zod'
import { PipelineWorkspace } from '../pipeline-contracts'
import { PipelineV2FindingLedger } from './pipeline-v2-findings'
import {
  PipelineV2Run,
  PipelineV2Invocation,
  PipelineV2EffectiveExecutor
} from './pipeline-v2-run-contracts'
import {
  pipelineV2Id,
  pipelineV2Digest,
  pipelineV2Source,
  pipelineV2Revision
} from './pipeline-v2-values'

export const PipelineV2RunSummary = PipelineV2Run.pick({
  id: true,
  engineVersion: true,
  revision: true,
  eventSequence: true,
  state: true,
  stageId: true,
  currentVisitId: true,
  definitionDigest: true,
  definitionEnabled: true,
  sourceRevision: true,
  reason: true,
  waitReason: true,
  pendingDecision: true,
  setupHold: true,
  pendingTransition: true,
  usedInvocations: true
}).extend({
  workspace: PipelineWorkspace.omit({ path: true }),
  visitCount: z.number().int().min(0).max(256),
  candidateCount: z.number().int().min(0).max(256),
  definition: z.strictObject({
    id: pipelineV2Id,
    title: z.string().max(120),
    version: z.string().max(64),
    completionPolicy: z.strictObject({ kind: z.enum(['workflow_complete', 'reviewed_source']) }),
    limits: z.strictObject({
      maxInvocations: z.number().int(),
      maxDiscussionTurns: z.number().int()
    }),
    stageCount: z.number().int().max(32),
    stagesTruncated: z.boolean(),
    stages: z
      .array(
        z.strictObject({
          id: pipelineV2Id,
          title: z.string().max(120),
          kind: z.enum(['agent', 'checks']),
          maxReentries: z.number().int(),
          ownerGate: z.boolean()
        })
      )
      .max(10)
  }),
  currentInvocation: PipelineV2Invocation.omit({
    message: true,
    clientPayloadDigest: true,
    synchronizationReceiptId: true,
    responseHistory: true
  }).optional(),
  currentExecutor: PipelineV2EffectiveExecutor.optional(),
  effectiveLimits: z.strictObject({
    maxInvocations: z.number().int().max(256),
    maxDiscussionTurns: z.number().int().max(64),
    maxReentries: z.number().int().max(20),
    reentryStageId: pipelineV2Id.optional(),
    usedDiscussionTurns: z.number().int().max(64),
    usedReentries: z.number().int().max(20)
  }),
  candidate: z
    .strictObject({
      id: pipelineV2Id,
      digest: pipelineV2Digest,
      summaryPreview: z.string().max(1000),
      summaryTruncated: z.boolean(),
      sessionId: pipelineV2Id
    })
    .optional()
})
export const PipelineV2StatusResult = z.strictObject({
  findingLedger: PipelineV2FindingLedger.optional(),
  contractVersion: z.literal(2),
  run: PipelineV2RunSummary,
  sourceRevision: pipelineV2Source.nullable(),
  sourceAvailable: z.boolean(),
  workflowComplete: z.boolean(),
  ready: z.boolean(),
  currentEvidence: z.boolean(),
  reason: z.string().max(500).optional(),
  repairEntryStageId: pipelineV2Id.optional()
})
export const PipelineV2OwnerRequestSummary = z.strictObject({
  requestId: pipelineV2Id,
  projectId: pipelineV2Id,
  kind: z.enum(['decision', 'budget', 'publish', 'disable']),
  createdAt: pipelineV2Revision,
  state: z.enum(['pending', 'resolved']),
  action: z.enum(['accept', 'rework', 'enable', 'disable']).optional(),
  subject: z.string().max(120).optional(),
  runId: pipelineV2Id.optional()
})
export type PipelineV2RunSummary = z.infer<typeof PipelineV2RunSummary>
export type PipelineV2StatusResult = z.infer<typeof PipelineV2StatusResult>
export type PipelineV2OwnerRequestSummary = z.infer<typeof PipelineV2OwnerRequestSummary>

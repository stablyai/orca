import * as z from 'zod'
import { PipelineCheck, PipelineWorkspace } from '../pipeline-contracts'
import { PipelineStageEvidence } from '../pipeline-stage-evidence'
import { PipelineV2ResponseObservation } from './pipeline-v2-response-observation'
import { PipelineV2FindingUpdate } from './pipeline-v2-findings'
import {
  PipelineV2CompiledTarget,
  PipelineV2Definition,
  PipelineV2Task
} from './pipeline-v2-contracts'
import {
  pipelineV2Digest,
  pipelineV2Id,
  pipelineV2RelativePath,
  pipelineV2Revision,
  pipelineV2Source,
  pipelineV2Text
} from './pipeline-v2-values'

export const PipelineSessionBinding = z.strictObject({
  kind: z.enum(['structured', 'terminal', 'checks']),
  sessionId: pipelineV2Id,
  compatibilityKey: pipelineV2Digest,
  terminalHandle: pipelineV2Id.optional(),
  paneKey: z.string().min(1).max(512).optional()
})
export const PipelineV2EffectiveExecutor = z.strictObject({
  agent: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  effort: z.string().min(1).max(128).optional(),
  surface: z.enum(['chat', 'terminal']),
  permissionMode: z.string().min(1).max(128),
  compatibilityKey: pipelineV2Digest
})
export const PipelineV2Evidence = z
  .union([
    PipelineStageEvidence,
    z.strictObject({
      stage: z.literal('generic'),
      statement: pipelineV2Text(2000),
      rationale: pipelineV2Text(2000),
      files: z.array(pipelineV2RelativePath).max(24)
    })
  ])
  .refine((value) => JSON.stringify(value).length <= 4000, 'pipeline_evidence_budget')
export const PipelineV2Submission = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('result'),
    outcomeId: pipelineV2Id,
    summary: pipelineV2Text(12000),
    explanation: pipelineV2Text(4000).optional(),
    findingUpdates: z.array(PipelineV2FindingUpdate).max(24).optional(),
    evidence: PipelineV2Evidence
  }),
  z.strictObject({
    status: z.literal('blocked'),
    reason: pipelineV2Text(500),
    summary: pipelineV2Text(12000),
    explanation: pipelineV2Text(4000).optional(),
    findingUpdates: z.array(PipelineV2FindingUpdate).max(24).optional(),
    evidence: PipelineV2Evidence.optional()
  })
])
export const PipelineV2Candidate = z.strictObject({
  id: pipelineV2Id,
  visitId: pipelineV2Id,
  invocationId: pipelineV2Id,
  dispatchId: pipelineV2Id,
  sessionId: pipelineV2Id,
  inputRevision: pipelineV2Revision,
  sourceRevision: pipelineV2Source,
  digest: pipelineV2Digest,
  discussionRevision: z.number().int().min(0).max(64),
  result: PipelineV2Submission,
  summary: pipelineV2Text(12000)
})
export const PipelineV2Invocation = z.strictObject({
  id: pipelineV2Id,
  visitId: pipelineV2Id,
  stageId: pipelineV2Id,
  purpose: z.enum(['stage', 'discussion', 'synchronize']),
  state: z.enum(['reserved', 'running', 'submitted', 'settled', 'uncertain']),
  inputRevision: pipelineV2Revision,
  sourceRevision: pipelineV2Source,
  discussionRevision: z.number().int().min(0).max(64),
  dispatchId: pipelineV2Id.optional(),
  session: PipelineSessionBinding.optional(),
  candidateId: pipelineV2Id.optional(),
  reviewCommit: pipelineV2Source.optional(),
  message: pipelineV2Text(4000).optional(),
  synchronizationReceiptId: pipelineV2Id.optional(),
  clientPayloadDigest: pipelineV2Digest.optional(),
  responseObservation: PipelineV2ResponseObservation.optional(),
  responseHistory: z.array(PipelineV2ResponseObservation).max(8).optional()
})
export const PipelineV2Handoff = z.strictObject({
  fromVisitId: pipelineV2Id,
  candidateId: pipelineV2Id,
  comment: pipelineV2Text(4000).optional()
})
export const PipelineV2Visit = z.strictObject({
  id: pipelineV2Id,
  stageId: pipelineV2Id,
  attempt: z.number().int().min(0).max(20),
  state: z.enum(['pending', 'running', 'waiting_owner', 'completed', 'blocked', 'interrupted']),
  discussionTurns: z.number().int().min(0).max(64),
  candidateIds: z.array(pipelineV2Id).max(65),
  acceptedCandidateId: pipelineV2Id.optional(),
  handoff: PipelineV2Handoff.optional()
})
export const PipelineV2DecisionPin = z.strictObject({
  id: pipelineV2Id,
  visitId: pipelineV2Id,
  candidateId: pipelineV2Id,
  candidateDigest: pipelineV2Digest,
  sourceRevision: pipelineV2Source,
  discussionRevision: z.number().int().min(0).max(64),
  proposedOutcomeId: pipelineV2Id,
  proposedTarget: PipelineV2CompiledTarget
})
export const PipelineV2BudgetExtension = z.strictObject({
  stageId: pipelineV2Id.optional(),
  maxReentries: z.number().int().min(0).max(20).optional(),
  visitId: pipelineV2Id.optional(),
  maxDiscussionTurns: z.number().int().min(1).max(64).optional(),
  maxInvocations: z.number().int().min(1).max(256).optional()
})
export const PipelineV2Admission = z.strictObject({
  id: z.string().min(1).max(64),
  requestId: pipelineV2Id,
  workspace: PipelineWorkspace,
  definition: PipelineV2Definition,
  task: PipelineV2Task,
  effectiveExecutors: z.record(pipelineV2Id, PipelineV2EffectiveExecutor),
  checkSnapshot: z.array(PipelineCheck).max(16),
  sourceRevision: pipelineV2Source,
  baseCommit: pipelineV2Source.optional(),
  waitForSetup: z.boolean().default(false)
})
export const PipelineV2Run = PipelineV2Admission.omit({
  requestId: true,
  waitForSetup: true
}).extend({
  engineVersion: z.literal(2),
  revision: pipelineV2Revision,
  eventSequence: pipelineV2Revision,
  definitionDigest: pipelineV2Digest,
  definitionEnabled: z.boolean(),
  state: z.enum([
    'waiting_setup',
    'running',
    'paused',
    'waiting_owner',
    'reconciliation_required',
    'completed',
    'failed'
  ]),
  stageId: pipelineV2Id,
  currentVisitId: pipelineV2Id,
  visits: z.array(PipelineV2Visit).max(256),
  invocations: z.array(PipelineV2Invocation).max(256),
  candidates: z.array(PipelineV2Candidate).max(256),
  usedInvocations: z.number().int().min(0).max(256),
  activeInvocationId: pipelineV2Id.optional(),
  pendingDecision: PipelineV2DecisionPin.optional(),
  pendingTransition: z
    .strictObject({ target: PipelineV2CompiledTarget, handoff: PipelineV2Handoff.optional() })
    .optional(),
  budgetExtensions: z.array(PipelineV2BudgetExtension).max(256),
  sessionGroups: z.record(pipelineV2Id, PipelineSessionBinding),
  reason: z.string().max(500).optional(),
  waitReason: z
    .enum(['owner_gate', 'budget', 'blocked', 'interrupted', 'session_sync', 'completion'])
    .optional(),
  unverifiedSessionInput: z
    .strictObject({ sessionId: pipelineV2Id, receiptId: pipelineV2Id })
    .optional(),
  setupHold: z.strictObject({ terminalHandle: pipelineV2Id.optional() }).optional()
})

export type PipelineSessionBinding = z.infer<typeof PipelineSessionBinding>
export type PipelineV2EffectiveExecutor = z.infer<typeof PipelineV2EffectiveExecutor>
export type PipelineV2Candidate = z.infer<typeof PipelineV2Candidate>
export type PipelineV2Invocation = z.infer<typeof PipelineV2Invocation>
export type PipelineV2Visit = z.infer<typeof PipelineV2Visit>
export type PipelineV2Handoff = z.infer<typeof PipelineV2Handoff>
export type PipelineV2Admission = z.infer<typeof PipelineV2Admission>
export type PipelineV2Run = z.infer<typeof PipelineV2Run>
export type PipelineV2Submission = z.infer<typeof PipelineV2Submission>

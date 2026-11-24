import { z } from 'zod'
import { PipelineStage, PipelineWorkspace, PipelineSelection } from './pipeline-contracts'
import { PipelineStageEvidence } from './pipeline-stage-evidence'

const id = z.string().min(1).max(256)
const revision = z.number().int().min(0)
const source = z.string().regex(/^[a-f0-9]{40,64}$/)
const active = z.strictObject({ dispatchId: id, sessionId: id, inputRevision: revision })

export const PipelineRunSummary = z.strictObject({
  id,
  workspace: PipelineWorkspace,
  definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.strictObject({ pluginKey: id, fingerprint: id }).optional(),
  baseCommit: source.optional(),
  revision,
  state: z.enum([
    'running',
    'waiting_setup',
    'paused',
    'waiting_owner',
    'reconciliation_required',
    'ready_for_review',
    'failed'
  ]),
  stage: PipelineStage,
  fixCycles: z.number().int().min(0).max(2),
  primarySessionId: id.optional(),
  checkedRevision: source.optional(),
  reviewCommit: source.optional(),
  afterChecks: z.enum(['docs', 'review']).optional(),
  reason: z.string().max(500).optional(),
  setupHold: z.strictObject({ terminalHandle: id.optional() }).optional(),
  active: active.optional(),
  profile: z.strictObject({
    id,
    title: z.string().min(1).max(120),
    version: PipelineSelection.shape.version
  }),
  artifactCount: z.number().int().min(0).max(128)
})

export const PipelineContextResponse = z
  .strictObject({
    runId: id,
    stage: PipelineStage,
    revision,
    task: z.string().max(12000),
    artifacts: z
      .array(
        z.strictObject({
          stage: PipelineStage,
          attempt: z.number().int().min(0).max(3),
          sourceRevision: source,
          body: z.string().max(12000),
          dispatchId: id,
          sessionId: id,
          verdict: z.enum(['pass', 'changes_requested', 'blocked']),
          evidence: PipelineStageEvidence.optional(),
          commit: source.optional(),
          truncated: z.boolean(),
          evidenceOmitted: z.boolean()
        })
      )
      .max(6),
    omittedStages: z.array(PipelineStage).max(6),
    reviewCommit: source.optional(),
    active: active.optional(),
    sourceRevision: source
  })
  .refine(
    (value) => JSON.stringify(value).length <= 16000,
    'Pipeline context exceeds serialized budget'
  )

export const PipelineStatusResponse = z.strictObject({
  run: PipelineRunSummary,
  sourceRevision: source.nullable(),
  currentEvidence: z.boolean(),
  ready: z.boolean(),
  sourceAvailable: z.boolean()
})

export const PipelinePublicResultSchemas = {
  list: z.toJSONSchema(z.strictObject({ runs: z.array(PipelineRunSummary).max(50) })),
  status: z.toJSONSchema(PipelineStatusResponse),
  context: z.toJSONSchema(PipelineContextResponse),
  control: z.toJSONSchema(z.strictObject({ run: PipelineRunSummary })),
  receipt: z.toJSONSchema(z.strictObject({ run: PipelineRunSummary.nullable() }))
}

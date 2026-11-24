import { z } from 'zod'
import { pipelineV2Digest, pipelineV2Id, pipelineV2Text } from './pipeline-v2-values'

export const PipelineV2Target = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stage'), stageId: pipelineV2Id }),
  z.strictObject({ kind: z.literal('next') }),
  z.strictObject({ kind: z.literal('finish') })
])
export const PipelineV2CompiledTarget = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('stage'), stageId: pipelineV2Id }),
  z.strictObject({ kind: z.literal('finish') })
])
export const PipelineV2SessionPolicy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fresh') }),
  z.strictObject({ kind: z.literal('reuse'), groupId: pipelineV2Id })
])
export const PipelineV2AgentExecutor = z.strictObject({
  agent: z.string().min(1).max(64),
  model: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('default') }),
    z.strictObject({ kind: z.literal('explicit'), id: z.string().min(1).max(128) })
  ]),
  effort: z.string().min(1).max(128).optional(),
  surface: z.enum(['chat', 'terminal']),
  session: PipelineV2SessionPolicy,
  permissionMode: z.string().min(1).max(128).optional()
})
const outcome = z.strictObject({
  id: pipelineV2Id,
  title: z.string().min(1).max(120),
  criterion: z.string().min(1).max(500),
  target: PipelineV2Target
})
const compiledOutcome = outcome.extend({ target: PipelineV2CompiledTarget })
const commonStage = z.strictObject({
  id: pipelineV2Id,
  title: z.string().min(1).max(120),
  instructions: z.string().max(6000),
  expectedResult: z.string().min(1).max(6000),
  inputs: z.strictObject({ task: z.boolean(), stageIds: z.array(pipelineV2Id).max(32) }),
  ownerGate: z.strictObject({ enabled: z.boolean(), reworkTargetStageId: pipelineV2Id }),
  maxReentries: z.number().int().min(0).max(10),
  outcomes: z.array(outcome).min(1).max(8)
})
const agentStage = commonStage.extend({
  kind: z.literal('agent'),
  executor: PipelineV2AgentExecutor,
  evidenceSchema: z.enum(['generic', 'plan', 'changes', 'review', 'docs']),
  independent: z.boolean()
})
const checksStage = commonStage.extend({
  kind: z.literal('checks'),
  executor: z.strictObject({ checkIds: z.array(pipelineV2Id).min(1).max(16) }),
  checkOutcomeMap: z.strictObject({ passed: pipelineV2Id, failed: pipelineV2Id })
})
export const PipelineV2Stage = z
  .discriminatedUnion('kind', [agentStage, checksStage])
  .refine(
    (stage) =>
      JSON.stringify(stage.instructions).length + JSON.stringify(stage.expectedResult).length <=
      6000,
    'pipeline_instruction_budget'
  )
export const PipelineV2CompiledStage = z.discriminatedUnion('kind', [
  agentStage.extend({ outcomes: z.array(compiledOutcome).min(1).max(8) }),
  checksStage.extend({ outcomes: z.array(compiledOutcome).min(1).max(8) })
])
export const PipelineV2CompletionPolicy = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('workflow_complete') }),
  z.strictObject({
    kind: z.literal('reviewed_source'),
    findingPolicy: z.enum(['latest_review', 'tracked']).optional(),
    checkRequirements: z
      .array(
        z.strictObject({ stageId: pipelineV2Id, checkIds: z.array(pipelineV2Id).min(1).max(16) })
      )
      .min(1)
      .max(32),
    reviewRequirements: z
      .array(
        z.strictObject({
          stageId: pipelineV2Id,
          acceptedOutcomeIds: z.array(pipelineV2Id).min(1).max(8),
          independent: z.boolean().optional(),
          freshSession: z.boolean().optional()
        })
      )
      .min(1)
      .max(32),
    repairEntryStageId: pipelineV2Id
  })
])
const definitionFields = {
  schemaVersion: z.literal(2),
  id: pipelineV2Id,
  projectId: pipelineV2Id,
  version: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  description: z.string().max(500),
  entryStageId: pipelineV2Id,
  limits: z.strictObject({
    maxInvocations: z.number().int().min(1).max(128),
    maxDiscussionTurns: z.number().int().min(1).max(32)
  }),
  completionPolicy: PipelineV2CompletionPolicy
}
export const PipelineV2Template = z.strictObject({
  ...definitionFields,
  stages: z.array(PipelineV2Stage).min(1).max(32)
})
export const PipelineV2Definition = z.strictObject({
  ...definitionFields,
  engineVersion: z.literal(2),
  stages: z.array(PipelineV2CompiledStage).min(1).max(32),
  digest: pipelineV2Digest
})
export const PipelineV2Task = pipelineV2Text(12000)

export type PipelineV2Target = z.infer<typeof PipelineV2Target>
export type PipelineV2CompiledTarget = z.infer<typeof PipelineV2CompiledTarget>
export type PipelineV2Stage = z.infer<typeof PipelineV2Stage>
export type PipelineV2CompiledStage = z.infer<typeof PipelineV2CompiledStage>
export type PipelineV2Template = z.infer<typeof PipelineV2Template>
export type PipelineV2Definition = z.infer<typeof PipelineV2Definition>
export type {
  PipelineV2Run,
  PipelineV2Visit,
  PipelineV2Invocation,
  PipelineV2Candidate,
  PipelineV2Admission
} from './pipeline-v2-run-contracts'
export type { PipelineV2Mutation } from './pipeline-v2-mutations'

import * as z from 'zod'
import {
  pipelineV2Id,
  pipelineV2Revision,
  pipelineV2Text
} from '../pipelines/v2/pipeline-v2-values'
import {
  PipelineV2Stage,
  PipelineV2Template,
  PipelineV2CompletionPolicy
} from '../pipelines/v2/pipeline-v2-contracts'
import {
  PipelineV2DecisionPin,
  PipelineV2BudgetExtension
} from '../pipelines/v2/pipeline-v2-run-contracts'
import {
  PipelineV2TemplateSelection,
  PipelineV2TemplatePublishInput,
  PipelineV2TemplateDisableInput
} from '../pipelines/v2/pipeline-v2-template-contracts'
import { PipelineSelection } from '../pipelines/pipeline-contracts'

export const PipelineV2RunParams = z.strictObject({
  id: pipelineV2Id,
  projectId: pipelineV2Id.optional(),
  expectedInstanceId: pipelineV2Id.optional(),
  expectedRuntimeId: pipelineV2Id.optional()
})
export const PipelineV2PageParams = z.strictObject({
  cursor: pipelineV2Revision.default(0),
  limit: z.number().int().min(1).max(50).default(50)
})
export const PipelineV2ProjectParams = z.strictObject({
  projectId: pipelineV2Id,
  expectedRuntimeId: pipelineV2Id.optional()
})
export const PipelineV2ListParams = PipelineV2ProjectParams.extend(PipelineV2PageParams.shape)
export const PipelineV2EventsParams = PipelineV2RunParams.extend(PipelineV2PageParams.shape)
export const PipelineV2ContextParams = PipelineV2RunParams.extend({
  visitId: pipelineV2Id.optional(),
  visitCursor: pipelineV2Revision.optional(),
  artifactId: pipelineV2Id.optional(),
  artifactCursor: pipelineV2Revision.optional(),
  limit: z.number().int().min(1).max(50).optional()
}).refine(
  (value) =>
    !(value.artifactId && value.artifactCursor !== undefined) &&
    !(
      value.visitCursor !== undefined &&
      (value.visitId || value.artifactId || value.artifactCursor !== undefined)
    ),
  'pipeline_context_selector_conflict'
)
export const PipelineV2DescribeParams = PipelineV2RunParams.partial().extend({
  stageId: pipelineV2Id.optional(),
  invocationId: pipelineV2Id.optional()
})
export const PipelineV2ControlParams = z.strictObject({
  id: pipelineV2Id,
  projectId: pipelineV2Id,
  expectedInstanceId: pipelineV2Id,
  expectedRuntimeId: pipelineV2Id,
  expectedRevision: pipelineV2Revision,
  requestId: pipelineV2Id
})
export const PipelineV2ReceiptParams = PipelineV2ControlParams.extend({
  kind: z.enum([
    'pause',
    'resume',
    'revalidate',
    'reconcile',
    'retry',
    'reserve',
    'decide',
    'extend_budget'
  ])
})
export const PipelineV2DiscussParams = PipelineV2ControlParams.extend({
  message: pipelineV2Text(4000),
  pin: PipelineV2DecisionPin
})
export const PipelineV2DecisionRequestParams = PipelineV2ControlParams.extend({
  action: z.enum(['accept', 'rework']),
  pin: PipelineV2DecisionPin,
  comment: pipelineV2Text(4000).optional()
})
export const PipelineV2BudgetRequestParams = PipelineV2ControlParams.extend({
  extension: PipelineV2BudgetExtension
})
export const PipelineV2TemplatePublishRequestParams = PipelineV2TemplatePublishInput.extend({
  expectedRuntimeId: pipelineV2Id
})
export const PipelineV2TemplateDisableRequestParams = PipelineV2TemplateDisableInput.extend({
  expectedRuntimeId: pipelineV2Id
})
export const PipelineV2RequestReceiptParams = PipelineV2ProjectParams.extend({
  requestId: pipelineV2Id
})
export const PipelineV2TemplateListParams = PipelineV2ListParams.extend({
  kind: z.enum(['drafts', 'versions']).default('versions'),
  enabledOnly: z.boolean().default(false)
})
export const PipelineV2TemplateShowParams = PipelineV2ProjectParams.extend({
  draftId: pipelineV2Id.optional(),
  selection: PipelineV2TemplateSelection.optional(),
  stageId: pipelineV2Id.optional(),
  full: z.boolean().default(false),
  cursor: pipelineV2Revision.default(0),
  limit: z.number().int().min(1).max(32).default(10)
}).refine(
  (value) => Boolean(value.draftId) !== Boolean(value.selection),
  'pipeline_template_selector_required'
)
export const PipelineV2DraftOperation = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('insert'),
    stage: PipelineV2Stage,
    afterStageId: pipelineV2Id.optional()
  }),
  z.strictObject({ kind: z.literal('update'), stage: PipelineV2Stage }),
  z.strictObject({ kind: z.literal('delete'), stageId: pipelineV2Id }),
  z.strictObject({ kind: z.literal('reorder'), stageIds: z.array(pipelineV2Id).min(1).max(32) }),
  z.strictObject({
    kind: z.literal('template'),
    title: z.string().min(1).max(120).optional(),
    description: z.string().max(500).optional(),
    entryStageId: pipelineV2Id.optional(),
    completionPolicy: PipelineV2CompletionPolicy.optional()
  })
])
const draftWrite = z.strictObject({
  projectId: pipelineV2Id,
  requestId: pipelineV2Id,
  expectedRuntimeId: pipelineV2Id,
  expectedRevision: pipelineV2Revision
})
export const PipelineV2TemplateDeleteParams = draftWrite.extend({ draftId: pipelineV2Id })
export type PipelineV2TemplateDeleteParams = z.infer<typeof PipelineV2TemplateDeleteParams>
export const PipelineV2TemplateSaveParams = z.union([
  draftWrite.extend({ draft: PipelineV2Template }),
  draftWrite.extend({
    draftId: pipelineV2Id,
    operations: z.array(PipelineV2DraftOperation).min(1).max(32)
  }),
  draftWrite.extend({
    id: pipelineV2Id,
    source: z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('seed'),
        seedId: z.enum(['coding', 'research', 'single', 'implement-checks', 'configurable-review'])
      }),
      z.strictObject({ kind: z.literal('v1-clone'), profile: PipelineSelection }),
      z.strictObject({ kind: z.literal('copy'), selection: PipelineV2TemplateSelection })
    ])
  })
])
export const PipelineV2TemplateValidateParams = PipelineV2ProjectParams.extend({
  draftId: pipelineV2Id,
  expectedRevision: pipelineV2Revision
})
export type PipelineV2RunParams = z.infer<typeof PipelineV2RunParams>
export type PipelineV2TemplateSaveParams = z.infer<typeof PipelineV2TemplateSaveParams>

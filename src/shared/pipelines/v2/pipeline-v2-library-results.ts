import * as z from 'zod'
import { PipelineV2Stage } from './pipeline-v2-contracts'
import {
  PipelineV2Draft,
  PipelineV2DraftReceipt,
  PipelineV2DraftDeleteReceipt,
  PipelineV2TemplateReceipt,
  PipelineV2TemplateSelection,
  PipelineV2TemplateProvenance,
  PipelineV2Version
} from './pipeline-v2-template-contracts'
import { PipelineV2OwnerRequest } from './pipeline-v2-owner-request-contracts'
import { PipelineV2EffectiveExecutor } from './pipeline-v2-run-contracts'
import { pipelineV2Id, pipelineV2Revision } from './pipeline-v2-values'

const metadata = z.strictObject({
  projectId: pipelineV2Id,
  id: pipelineV2Id,
  title: z.string().max(120),
  description: z.string().max(500),
  stageCount: z.number().int().min(1).max(32)
})
export const PipelineV2TemplateListItem = z.discriminatedUnion('kind', [
  metadata.extend({
    kind: z.literal('drafts'),
    revision: pipelineV2Revision,
    updatedAt: pipelineV2Revision
  }),
  metadata.extend({
    kind: z.literal('versions'),
    selection: PipelineV2TemplateSelection,
    enabled: z.boolean(),
    publishedAt: pipelineV2Revision
  })
])
export const PipelineV2TemplatePage = z.strictObject({
  projectId: pipelineV2Id,
  templates: z.array(PipelineV2TemplateListItem).max(50),
  cursor: pipelineV2Revision,
  hasMore: z.boolean()
})
export const PipelineV2TemplateShowResult = z.strictObject({
  contractVersion: z.literal(2),
  projectId: pipelineV2Id,
  id: pipelineV2Id,
  title: z.string().max(120),
  description: z.string().max(500),
  provenance: PipelineV2TemplateProvenance,
  stageCount: z.number().int().min(1).max(32),
  draftId: pipelineV2Id.optional(),
  revision: pipelineV2Revision.optional(),
  selection: PipelineV2TemplateSelection.optional(),
  enabled: z.boolean().optional(),
  stages: z
    .array(
      z.strictObject({
        id: pipelineV2Id,
        title: z.string().max(120),
        kind: z.enum(['agent', 'checks'])
      })
    )
    .max(32),
  cursor: pipelineV2Revision,
  hasMore: z.boolean(),
  stage: PipelineV2Stage.optional(),
  record: z.union([PipelineV2Draft, PipelineV2Version]).optional(),
  launchPreview: z
    .array(
      z.discriminatedUnion('state', [
        z.strictObject({
          stageId: pipelineV2Id,
          state: z.literal('available'),
          executor: PipelineV2EffectiveExecutor
        }),
        z.strictObject({
          stageId: pipelineV2Id,
          state: z.literal('unavailable'),
          reason: z
            .string()
            .regex(/^pipeline_[a-z_]{1,120}$/)
            .optional()
        })
      ])
    )
    .max(32)
    .optional()
})
export const PipelineV2TemplateSaveResult = z.strictObject({
  contractVersion: z.literal(2),
  receipt: PipelineV2DraftReceipt
})
export const PipelineV2TemplateDeleteResult = z.strictObject({
  contractVersion: z.literal(2),
  receipt: PipelineV2DraftDeleteReceipt
})
export const PipelineV2TemplateReceiptResult = z.strictObject({
  contractVersion: z.literal(2),
  projectId: pipelineV2Id,
  request: PipelineV2OwnerRequest.nullable(),
  receipt: z
    .union([PipelineV2DraftReceipt, PipelineV2DraftDeleteReceipt, PipelineV2TemplateReceipt])
    .nullable()
})
export type PipelineV2TemplateListItem = z.infer<typeof PipelineV2TemplateListItem>
export type PipelineV2TemplateShowResult = z.infer<typeof PipelineV2TemplateShowResult>

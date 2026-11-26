import * as z from 'zod'
import { PipelineV2Definition, PipelineV2Template } from './pipeline-v2-contracts'
import { pipelineV2Digest, pipelineV2Id, pipelineV2Revision } from './pipeline-v2-values'

export const PipelineV2TemplateSelection = z.strictObject({
  engineVersion: z.literal(2).default(2),
  projectId: pipelineV2Id,
  id: pipelineV2Id,
  version: z.string().min(1).max(64),
  digest: pipelineV2Digest
})
export const PipelineV2TemplateProvenance = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('native') }),
  z.strictObject({ kind: z.literal('seed'), seedId: pipelineV2Id }),
  z.strictObject({ kind: z.literal('copy'), source: PipelineV2TemplateSelection }),
  z.strictObject({ kind: z.literal('v1-clone'), profileId: pipelineV2Id, digest: pipelineV2Digest })
])
export const PipelineV2Draft = z.strictObject({
  projectId: pipelineV2Id,
  draftId: pipelineV2Id,
  revision: pipelineV2Revision,
  draft: PipelineV2Template,
  provenance: PipelineV2TemplateProvenance,
  updatedAt: pipelineV2Revision
})
export const PipelineV2DraftReceipt = z.strictObject({
  requestId: pipelineV2Id,
  projectId: pipelineV2Id,
  draftId: pipelineV2Id,
  revision: pipelineV2Revision,
  draftDigest: pipelineV2Digest
})
export const PipelineV2DraftDeleteReceipt = PipelineV2DraftReceipt.extend({
  action: z.literal('deleted')
})
export const PipelineV2Version = z.strictObject({
  definition: PipelineV2Definition,
  enabled: z.boolean(),
  provenance: PipelineV2TemplateProvenance,
  publishedAt: pipelineV2Revision
})
export const PipelineV2TemplateReceipt = z.strictObject({
  requestId: pipelineV2Id,
  selection: PipelineV2TemplateSelection,
  action: z.enum(['published', 'enabled', 'disabled']),
  enabled: z.boolean()
})
export const PipelineV2DraftSaveInput = z.strictObject({
  requestId: pipelineV2Id,
  projectId: pipelineV2Id,
  expectedRevision: pipelineV2Revision,
  draft: PipelineV2Template
})
export const PipelineV2TemplatePublishInput = z.strictObject({
  requestId: pipelineV2Id,
  projectId: pipelineV2Id,
  draftId: pipelineV2Id,
  expectedRevision: pipelineV2Revision
})
export const PipelineV2TemplateDisableInput = PipelineV2TemplateSelection.extend({
  requestId: pipelineV2Id,
  enabled: z.boolean()
})
export const PipelineV2TemplateCopyInput = z.strictObject({
  requestId: pipelineV2Id,
  source: PipelineV2TemplateSelection,
  projectId: pipelineV2Id,
  id: pipelineV2Id
})
export type PipelineV2DraftReceipt = z.infer<typeof PipelineV2DraftReceipt>
export type PipelineV2DraftDeleteReceipt = z.infer<typeof PipelineV2DraftDeleteReceipt>
export type PipelineV2Version = z.infer<typeof PipelineV2Version>
export type PipelineV2TemplateSelection = z.infer<typeof PipelineV2TemplateSelection>
export type PipelineV2TemplatePublishInput = z.infer<typeof PipelineV2TemplatePublishInput>
export type PipelineV2TemplateDisableInput = z.infer<typeof PipelineV2TemplateDisableInput>
export type PipelineV2TemplateReceipt = z.infer<typeof PipelineV2TemplateReceipt>

import * as z from 'zod'
import { PipelineCheck, PipelineMutation, PipelineStage } from '../pipelines/pipeline-contracts'

const id = z.string().min(1).max(256)
export const PipelineRunParams = z.strictObject({ id })
export const PipelineReconcileParams = z.strictObject({ id, setupTerminal: id.optional() })
export const PipelineContextParams = z.strictObject({
  id,
  artifactStage: PipelineStage.optional(),
  artifactIndex: z.number().int().min(0).max(127).optional()
})
export const PipelineControlParams = z.strictObject({
  id,
  requestId: id,
  expectedRevision: z.number().int().min(0),
  expectedRuntimeId: id.optional()
})
export const PipelineReceiptParams = PipelineControlParams.extend({
  kind: z.enum(['pause', 'resume', 'revalidate'])
})
export const PipelineSubmitParams = z.strictObject({ id, mutation: PipelineMutation })
export const PipelineConfigureParams = z.strictObject({
  projectId: id,
  checks: z.array(PipelineCheck).min(1).max(16)
})

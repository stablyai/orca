import * as z from 'zod'

export const pipelineV2Id = z.string().min(1).max(256)
export const pipelineV2Revision = z.number().int().min(0)
export const pipelineV2Source = z.string().regex(/^[a-f0-9]{40,64}$/)
export const pipelineV2Digest = z.string().regex(/^[a-f0-9]{64}$/)
export const pipelineV2RelativePath = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.includes('\0') &&
      !/^(?:[a-z]:|[/\\])/i.test(value) &&
      !value.split(/[/\\]/).includes('..'),
    'pipeline_artifact_path_invalid'
  )

export function pipelineV2Text(limit: number, required = true) {
  return z
    .string()
    .max(limit)
    .refine((value) => !required || value.trim().length > 0, 'pipeline_text_required')
    .refine((value) => JSON.stringify(value).length <= limit, 'pipeline_text_budget')
}

export function pipelineV2SerializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}

import { z } from 'zod'
import { requiredString } from '../rpc-param-primitives'

export const GetPipelineConfig = z.object({
  workspaceRoot: requiredString('Missing workspaceRoot')
})
export type GetPipelineConfig = z.infer<typeof GetPipelineConfig>

export const RunPipelineCheckGate = z.object({
  workdir: requiredString('Missing workdir'),
  base: z.string().optional()
})
export type RunPipelineCheckGate = z.infer<typeof RunPipelineCheckGate>

export const RunPipelineReview = z.object({
  workdir: requiredString('Missing workdir'),
  mode: z.enum(['delegate', 'native']).optional(),
  base: z.string().optional()
})
export type RunPipelineReview = z.infer<typeof RunPipelineReview>

export const RunPipelineCiWatch = z.object({
  workdir: requiredString('Missing workdir'),
  prNumber: z.number().int().positive().optional(),
  runId: z.number().int().positive().optional()
})
export type RunPipelineCiWatch = z.infer<typeof RunPipelineCiWatch>

export const RunPipelineMerge = z.object({
  workdir: requiredString('Missing workdir'),
  prNumber: z.number().int().positive(),
  method: z.enum(['squash', 'merge', 'rebase']).optional()
})
export type RunPipelineMerge = z.infer<typeof RunPipelineMerge>

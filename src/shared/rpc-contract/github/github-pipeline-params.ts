import { z } from 'zod'
import { requiredString } from '../rpc-param-primitives'

export const GetPipelineConfig = z.object({
  workspaceRoot: requiredString('Missing workspaceRoot')
})
export type GetPipelineConfig = z.infer<typeof GetPipelineConfig>

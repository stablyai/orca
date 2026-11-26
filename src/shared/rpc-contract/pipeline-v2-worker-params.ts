import * as z from 'zod'
import { pipelineV2Id } from '../pipelines/v2/pipeline-v2-values'
import { PipelineV2Mutation } from '../pipelines/v2/pipeline-v2-mutations'
export { PipelineV2ContextParams as PipelineV2WorkerContextParams } from './pipeline-v2-params'

export const PipelineV2WorkerSubmitParams = z.strictObject({
  id: pipelineV2Id,
  mutation: PipelineV2Mutation
})

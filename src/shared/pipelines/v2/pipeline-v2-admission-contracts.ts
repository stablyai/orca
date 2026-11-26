import * as z from 'zod'
import { PipelineCheck } from '../pipeline-contracts'
import { PipelineV2Definition, PipelineV2Task } from './pipeline-v2-contracts'
import { PipelineV2EffectiveExecutor } from './pipeline-v2-run-contracts'
import { PipelineV2TemplateSelection } from './pipeline-v2-template-contracts'
import { pipelineV2Id } from './pipeline-v2-values'

export const PipelineV2CreationSnapshot = z.strictObject({
  schemaVersion: z.literal(2),
  creationId: pipelineV2Id,
  selection: PipelineV2TemplateSelection,
  definition: PipelineV2Definition,
  task: PipelineV2Task,
  checkSnapshot: z.array(PipelineCheck).max(16),
  effectiveExecutors: z.record(pipelineV2Id, PipelineV2EffectiveExecutor)
})
export type PipelineV2CreationSnapshot = z.infer<typeof PipelineV2CreationSnapshot>

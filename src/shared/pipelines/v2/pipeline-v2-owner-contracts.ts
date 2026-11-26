import * as z from 'zod'
import { PipelineV2Mutation } from './pipeline-v2-mutations'
import { pipelineV2Id } from './pipeline-v2-values'
import { PipelineV2DiscussionInput } from './pipeline-v2-discussion-contracts'

export const PipelineV2OwnerInput = z.strictObject({
  id: pipelineV2Id,
  workspaceId: pipelineV2Id,
  projectId: pipelineV2Id,
  expectedRuntimeId: pipelineV2Id,
  mutation: PipelineV2Mutation
})
export type PipelineV2DecisionInput = z.infer<typeof PipelineV2OwnerInput>
export type PipelineV2BudgetInput = z.infer<typeof PipelineV2OwnerInput>
export const PIPELINE_V2_SYNCHRONIZATION_MESSAGE =
  'Assess the owner input in this same session and the current source. Return an updated structured candidate. This is synchronization, not owner acceptance.'
export const PipelineV2OwnerSynchronizeInput = PipelineV2DiscussionInput.extend({
  expectedRuntimeId: pipelineV2Id
})
export type PipelineV2OwnerSynchronizeInput = z.infer<typeof PipelineV2OwnerSynchronizeInput>

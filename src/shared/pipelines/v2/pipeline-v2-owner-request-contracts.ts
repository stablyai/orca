import { z } from 'zod'
import {
  PipelineV2DecisionRequestParams,
  PipelineV2BudgetRequestParams,
  PipelineV2TemplatePublishRequestParams,
  PipelineV2TemplateDisableRequestParams
} from '../../rpc-contract/pipeline-v2-params'
import { pipelineV2Id } from './pipeline-v2-values'

const base = z.strictObject({
  requestId: pipelineV2Id,
  projectId: pipelineV2Id,
  createdAt: z.number().int().nonnegative(),
  state: z.literal('pending')
})
export const PipelineV2OwnerRequest = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('decision'), input: PipelineV2DecisionRequestParams }),
  base.extend({ kind: z.literal('budget'), input: PipelineV2BudgetRequestParams }),
  base.extend({ kind: z.literal('publish'), input: PipelineV2TemplatePublishRequestParams }),
  base.extend({ kind: z.literal('disable'), input: PipelineV2TemplateDisableRequestParams })
])
export type PipelineV2OwnerRequest = z.infer<typeof PipelineV2OwnerRequest>

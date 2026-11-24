import * as z from 'zod'
import { PipelineCheckResult } from '../pipeline-stage-evidence'
import { PipelineSessionBinding } from './pipeline-v2-run-contracts'
import {
  pipelineV2Digest,
  pipelineV2Id,
  pipelineV2Revision,
  pipelineV2Source
} from './pipeline-v2-values'

export const PipelineV2Receipt = z.strictObject({
  runId: pipelineV2Id,
  requestId: pipelineV2Id,
  inputRevision: pipelineV2Revision,
  acceptedRevision: pipelineV2Revision,
  kind: z.string().min(1).max(64),
  payloadDigest: pipelineV2Digest,
  definitionDigest: pipelineV2Digest,
  workspaceInstanceId: pipelineV2Id,
  state: z.string().min(1).max(64),
  stageId: pipelineV2Id,
  eventSequence: pipelineV2Revision,
  sourceRevision: pipelineV2Source,
  candidateId: pipelineV2Id.optional(),
  candidateDigest: pipelineV2Digest.optional()
})
export const PipelineV2Event = z.strictObject({
  runId: pipelineV2Id,
  workspaceInstanceId: pipelineV2Id,
  sequence: pipelineV2Revision,
  revision: pipelineV2Revision,
  kind: z.string().min(1).max(64),
  stageId: pipelineV2Id,
  visitId: pipelineV2Id,
  state: z.string().min(1).max(64),
  reason: z.string().max(500).optional()
})
export const PipelineV2EventPage = z.strictObject({
  events: z.array(PipelineV2Event).max(50),
  cursor: pipelineV2Revision,
  hasMore: z.boolean(),
  latestSequence: pipelineV2Revision
})
export const PipelineCheckOutcome = z.strictObject({
  category: z.enum(['passed', 'failed', 'unknown']),
  body: z.string().max(12000),
  results: z.array(PipelineCheckResult).max(16)
})
export const PipelineV2InvocationReceipt = z.strictObject({
  state: z.enum(['ready', 'outcome_unknown', 'not_started']),
  reason: z
    .string()
    .regex(/^pipeline_[a-z_]{1,120}$/)
    .optional(),
  dispatchId: pipelineV2Id.optional(),
  responseMessageId: pipelineV2Id.optional(),
  session: PipelineSessionBinding.optional()
})
export type PipelineV2Receipt = z.infer<typeof PipelineV2Receipt>
export type PipelineV2Event = z.infer<typeof PipelineV2Event>
export type PipelineV2EventPage = z.infer<typeof PipelineV2EventPage>
export type PipelineCheckOutcome = z.infer<typeof PipelineCheckOutcome>
export type PipelineV2InvocationReceipt = z.infer<typeof PipelineV2InvocationReceipt>

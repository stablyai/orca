import * as z from 'zod'
import { pipelineV2Digest, pipelineV2Id } from './v2/pipeline-v2-values'

const legacy = z.strictObject({
  runId: pipelineV2Id,
  profileId: pipelineV2Id,
  version: z.string().min(1).max(64),
  digest: pipelineV2Digest,
  engineVersion: z.literal(1).optional()
})
export const PipelineAssociation = z.union([
  legacy,
  legacy.extend({ engineVersion: z.literal(2), projectId: pipelineV2Id })
])
export type PipelineAssociation = z.infer<typeof PipelineAssociation>

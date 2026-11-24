import { z } from 'zod'
import { pipelineV2Digest, pipelineV2Id } from './pipeline-v2-values'
import { AgentSessionTurnTokenCountsSchema } from '../../agent-session/conversation-context/agent-session-turn-token-accounting'

export const PipelineV2StageUsage = z.strictObject({
  durationMs: z.number().nonnegative().nullable(),
  tokens: AgentSessionTurnTokenCountsSchema.nullable(),
  usd: z.null(),
  source: z.literal('journal_turn')
})

export const PipelineV2ResponseObservation = z.strictObject({
  requestMessageId: pipelineV2Id,
  clientMessageId: pipelineV2Id,
  turnItemId: pipelineV2Id.optional(),
  responseItemId: pipelineV2Id.optional(),
  rawResponse: z.string().max(12000).optional(),
  rawDigest: pipelineV2Digest.optional(),
  rawTruncated: z.boolean().optional(),
  category: z.enum([
    'result',
    'quota',
    'cancellation',
    'transport_unknown',
    'malformed_result',
    'source_mismatch'
  ]),
  providerCategory: z
    .enum(['result', 'quota', 'cancellation', 'transport_unknown', 'malformed_result'])
    .optional(),
  reason: z.string().max(500).optional(),
  usage: PipelineV2StageUsage.optional(),
  validationErrors: z
    .array(
      z.strictObject({
        path: z.string().max(500),
        code: z.string().max(120),
        message: z.string().max(1000)
      })
    )
    .max(32)
    .optional()
})
export type PipelineV2ResponseObservation = z.infer<typeof PipelineV2ResponseObservation>

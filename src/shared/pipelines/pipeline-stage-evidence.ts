import * as z from 'zod'
import { PipelineV2FindingId } from './v2/pipeline-v2-findings'

const text = z.string().min(1).max(500)
const path = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) => !/^(?:[a-z]:|[/\\])/i.test(value) && !value.split(/[/\\]/).includes('..'),
    'workspace-relative path required'
  )
export const PipelineCheckResult = z.strictObject({
  id: z.string().min(1).max(256),
  code: z.number().int().nullable(),
  timedOut: z.boolean(),
  outputTruncated: z.boolean()
})
export const PipelineStageEvidence = z
  .discriminatedUnion('stage', [
    z.strictObject({
      stage: z.literal('plan'),
      criteria: z.array(text).min(1).max(12),
      steps: z.array(text).min(1).max(12)
    }),
    z.strictObject({ stage: z.enum(['implement', 'fix']), changes: z.array(text).min(1).max(24) }),
    z
      .strictObject({
        stage: z.literal('docs'),
        files: z.array(path).max(24),
        rationale: z.string().min(1).max(2000).optional()
      })
      .refine(
        (value) => value.files.length > 0 || Boolean(value.rationale),
        'Documentation files or no-update rationale required'
      ),
    z.strictObject({
      stage: z.literal('review'),
      findings: z
        .array(
          z.strictObject({
            id: PipelineV2FindingId.optional(),
            severity: z.enum(['critical', 'important', 'minor']),
            detail: text,
            conditionToFix: text,
            path: path.optional()
          })
        )
        .max(24)
    }),
    z.strictObject({
      stage: z.literal('checks'),
      results: z.array(PipelineCheckResult).min(1).max(16)
    })
  ])
  .refine((value) => JSON.stringify(value).length <= 4000, 'Stage evidence exceeds 4000 characters')
export type PipelineStageEvidence = z.infer<typeof PipelineStageEvidence>
export type PipelineCheckResult = z.infer<typeof PipelineCheckResult>

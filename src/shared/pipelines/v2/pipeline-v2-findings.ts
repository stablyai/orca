import * as z from 'zod'
import { pipelineV2Fingerprint } from './pipeline-v2-fingerprint'

export const PipelineV2FindingId = z.string().regex(/^finding:[a-f0-9]{64}$/)
export const PipelineV2FindingUpdate = z
  .strictObject({
    id: PipelineV2FindingId,
    disposition: z.enum(['fixed', 'open', 'disputed']),
    rationale: z.string().min(1).max(500),
    requirement: z.string().min(1).max(500).optional()
  })
  .refine(
    (value) => value.disposition !== 'disputed' || Boolean(value.requirement),
    'pipeline_finding_requirement_required'
  )

export function pipelineV2FindingId(finding: {
  id?: string
  path?: string
  detail: string
  conditionToFix: string
}): string {
  return (
    finding.id ??
    `finding:${pipelineV2Fingerprint({ path: finding.path ?? '', detail: finding.detail, conditionToFix: finding.conditionToFix })}`
  )
}

export const PipelineV2FindingLedger = z.strictObject({
  total: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  unresolvedImportant: z.number().int().nonnegative(),
  findings: z
    .array(
      z.strictObject({
        id: PipelineV2FindingId,
        candidateId: z.string().min(1).max(256),
        severity: z.enum(['critical', 'important', 'minor']),
        detail: z.string().max(180),
        conditionToFix: z.string().max(180),
        disposition: z.enum(['fixed_verified', 'open', 'disputed']),
        rationale: z.string().max(180).optional(),
        requirement: z.string().max(180).optional(),
        proposedFixed: z.boolean(),
        ownerAcknowledged: z.boolean()
      })
    )
    .max(24)
})

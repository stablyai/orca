import * as z from 'zod'
import { PipelineStageEvidence } from '../pipeline-stage-evidence'
import { PipelineV2Evidence } from './pipeline-v2-run-contracts'
import { PipelineV2FindingUpdate } from './pipeline-v2-findings'
import type { PipelineV2CompiledStage } from './pipeline-v2-contracts'
import {
  pipelineV2Id,
  pipelineV2Revision,
  pipelineV2Source,
  pipelineV2Text
} from './pipeline-v2-values'

type EvidenceKind = 'generic' | 'plan' | 'changes' | 'review' | 'docs' | 'checks'
export function pipelineV2EvidenceContract(kind: EvidenceKind) {
  if (kind === 'generic') {
    return PipelineV2Evidence.options[1]
  }
  const variants = PipelineStageEvidence.options
  if (kind === 'changes') {
    return variants[1]
  }
  return { plan: variants[0], review: variants[3], docs: variants[2], checks: variants[4] }[kind]
}
export function pipelineV2EvidenceExample(kind: EvidenceKind) {
  return {
    generic: {
      stage: 'generic',
      statement: 'Expected result is available',
      rationale: 'Explain how the result meets the stage criterion',
      files: []
    },
    plan: { stage: 'plan', criteria: ['Acceptance criterion'], steps: ['Implementation step'] },
    changes: { stage: 'implement', changes: ['Path and concrete change'] },
    review: { stage: 'review', findings: [] },
    docs: { stage: 'docs', files: [], rationale: 'Explain why no documentation update is useful' },
    checks: {
      stage: 'checks',
      results: [{ id: 'check-id', code: 0, timedOut: false, outputTruncated: false }]
    }
  }[kind]
}
const schemas = new Map<EvidenceKind, Record<string, unknown>>()
export function pipelineV2SubmitSchema(stage: PipelineV2CompiledStage) {
  const kind = stage.kind === 'checks' ? 'checks' : stage.evidenceSchema
  let schema = schemas.get(kind)
  if (!schema) {
    const evidence = pipelineV2EvidenceContract(kind)
    schema = z.toJSONSchema(
      z.strictObject({
        requestId: pipelineV2Id,
        expectedRevision: pipelineV2Revision,
        expectedInstanceId: pipelineV2Id,
        command: z.strictObject({
          kind: z.literal('submit'),
          invocationId: pipelineV2Id,
          dispatchId: pipelineV2Id,
          inputRevision: pipelineV2Revision,
          sourceRevision: pipelineV2Source,
          result: z.discriminatedUnion('status', [
            z.strictObject({
              status: z.literal('result'),
              outcomeId: pipelineV2Id,
              summary: pipelineV2Text(12000),
              explanation: pipelineV2Text(4000).optional(),
              findingUpdates: z.array(PipelineV2FindingUpdate).max(24).optional(),
              evidence
            }),
            z.strictObject({
              status: z.literal('blocked'),
              reason: pipelineV2Text(500),
              summary: pipelineV2Text(12000),
              explanation: pipelineV2Text(4000).optional(),
              findingUpdates: z.array(PipelineV2FindingUpdate).max(24).optional(),
              evidence: evidence.optional()
            })
          ])
        })
      }),
      { reused: 'ref' }
    )
    schemas.set(kind, schema)
  }
  return schema
}

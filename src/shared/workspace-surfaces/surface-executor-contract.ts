import { surfaceExecutionProvenanceSchema } from './surface-execution-provenance'
import { z } from 'zod'
import {
  surfaceAllocationSchema,
  surfaceResourceSchema,
  surfaceRunTargetSchema
} from './surface-allocation'

const id = z.string().min(1)
export const surfaceExecutionScopeSchema = z.strictObject({ databasePath: id, profileId: id })
export type SurfaceExecutionScope = z.infer<typeof surfaceExecutionScopeSchema>

export const surfaceExecutorCandidateSchema = z.strictObject({
  scope: surfaceExecutionScopeSchema,
  hostId: id,
  allocationId: id,
  resourceId: id
})
export type SurfaceExecutorCandidate = z.infer<typeof surfaceExecutorCandidateSchema>
export const surfaceExecutorAdmissionSchema = surfaceExecutorCandidateSchema.extend({
  executorId: id,
  provenance: surfaceExecutionProvenanceSchema.nullable().optional()
})
export type SurfaceExecutorAdmission = z.infer<typeof surfaceExecutorAdmissionSchema>

export const surfaceExecutorIntentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('allocation'), allocation: surfaceAllocationSchema }),
  z.strictObject({
    kind: z.literal('bound'),
    target: surfaceRunTargetSchema,
    resource: surfaceResourceSchema
  }),
  z.strictObject({ kind: z.literal('absent') }),
  z.strictObject({ kind: z.literal('unreadable') })
])
export type SurfaceExecutorIntent = z.infer<typeof surfaceExecutorIntentSchema>

export const surfaceExecutorDecisionSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    admission: surfaceExecutorAdmissionSchema,
    decision: z.literal('committed'),
    resource: surfaceResourceSchema
  }),
  z.strictObject({
    admission: surfaceExecutorAdmissionSchema,
    decision: z.literal('aborting'),
    resource: surfaceResourceSchema.nullable()
  })
])
export type SurfaceExecutorDecision = z.infer<typeof surfaceExecutorDecisionSchema>

export const surfaceExecutorResultSchema = z.object({
  executorId: id,
  admission: surfaceExecutorAdmissionSchema,
  state: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('prepared'), resource: surfaceResourceSchema }),
    z.strictObject({ kind: z.literal('adopted'), resource: surfaceResourceSchema }),
    z.strictObject({ kind: z.literal('canceled') }),
    z.strictObject({ kind: z.literal('pending') }),
    z.strictObject({ kind: z.literal('unverifiable') })
  ])
})
export type SurfaceExecutorResult = z.infer<typeof surfaceExecutorResultSchema>

export function surfaceExecutorKey(admission: SurfaceExecutorAdmission): string {
  return JSON.stringify([
    admission.executorId,
    admission.hostId,
    admission.allocationId,
    admission.resourceId
  ])
}

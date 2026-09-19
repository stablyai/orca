import { z } from 'zod'
import { createHash } from 'node:crypto'
import { OrcadManagedDecommissionParamsSchema } from './orcad-managed-decommission'
import {
  OrcadManagedStopInstanceSchema,
  type OrcadManagedStopInstance
} from './orcad-managed-stop-instance'

// A distinct filename prevents older listeners from consuming an authority-bound request.
export const ORCAD_MANAGED_STOP_REQUEST_FILENAME = '.orcad-managed-stop-request'
export const ORCAD_MANAGED_STOP_REQUEST_MAX_BYTES = 32 * 1024

export function orcadManagedStopRequestFilename(instance: OrcadManagedStopInstance): string {
  const nonce = OrcadManagedStopInstanceSchema.parse(instance).nonce
  return `${ORCAD_MANAGED_STOP_REQUEST_FILENAME}.${createHash('sha256').update(nonce).digest('hex')}`
}

export const OrcadManagedStopRequestSchema = OrcadManagedDecommissionParamsSchema.extend({
  schemaVersion: z.literal(1),
  instance: OrcadManagedStopInstanceSchema
})

export type OrcadManagedStopRequest = z.infer<typeof OrcadManagedStopRequestSchema>

export const OrcadManagedStopCompletionSchema = OrcadManagedStopRequestSchema.extend({
  kind: z.literal('orcad_managed_stop_completion'),
  verdict: z.enum(['live', 'unverifiable', 'exited']),
  receiptPersisted: z.boolean().optional()
})

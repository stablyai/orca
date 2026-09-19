import { z } from 'zod'
import { OrcadDecommissionResultSchema } from './orcad-decommission'
import { OrcadManagedStopRequestSchema } from './orcad-managed-stop-request'

export const ORCAD_CANCELED_STOPS_DIRNAME = 'orcad-canceled-stops'
export const OrcadCanceledStopReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('orcad_managed_stop_canceled'),
  request: OrcadManagedStopRequestSchema
})

export function orcadCanceledStopReceiptFilename(transactionId: string): string {
  return `${z.uuid().parse(transactionId)}.json`
}

export const OrcadManagedStopCancellationResultSchema = z.discriminatedUnion('outcome', [
  OrcadManagedStopRequestSchema.extend({ outcome: z.literal('canceled') }),
  OrcadDecommissionResultSchema.options[1]
])

export type OrcadManagedStopCancellationResult = z.infer<
  typeof OrcadManagedStopCancellationResultSchema
>

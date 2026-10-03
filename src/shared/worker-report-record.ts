import { z } from 'zod'
import { PairingOfferSchema } from './pairing'

const Identity = z.string().min(1).max(512)
export const WorkerReportInputSchema = z
  .object({
    requestId: Identity,
    params: z
      .object({
        from: Identity,
        type: z.literal('worker_done'),
        subject: z.string(),
        payload: z.string().refine((text) => {
          try {
            return z
              .object({
                taskId: Identity,
                dispatchId: Identity,
                outcome: z.enum(['succeeded', 'failed'])
              })
              .safeParse(JSON.parse(text)).success
          } catch {
            return false
          }
        }, 'An exact Task, Dispatch and outcome are required')
      })
      .passthrough(),
    envelope: z.object({
      orchestrationCapability: Identity,
      orchestrationRequestId: Identity,
      orchestrationContractVersion: z.number().int(),
      compatibilityInvocationId: z.string().optional()
    }),
    pairing: PairingOfferSchema.nullable()
  })
  .refine((record) => record.requestId === record.envelope.orchestrationRequestId)

export const WorkerReportRecordSchema = z.object({
  version: z.literal(1),
  input: WorkerReportInputSchema,
  createdAt: z.number(),
  nextAttemptAt: z.number(),
  attempts: z.number().int().nonnegative()
})
export const WorkerReportRejectionSchema = z.object({
  version: z.literal(1),
  requestId: Identity,
  rejectedAt: z.number(),
  code: z.string(),
  taskId: Identity,
  dispatchId: Identity
})
export type WorkerReportInput = z.infer<typeof WorkerReportInputSchema>
export type WorkerReportRecord = z.infer<typeof WorkerReportRecordSchema>
export const WORKER_REPORT_MAX_BYTES = 256 * 1024
export const WORKER_REPORT_MAX_RECORDS = 256
export const WORKER_REPORT_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
export const WORKER_REPORT_REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

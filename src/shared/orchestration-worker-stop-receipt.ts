import { z } from 'zod'

/** One helper under a stopped worker, and what its stop did. */
export const HelperStopOutcome = z.object({
  dispatchId: z.string(),
  creatorDispatchId: z.string(),
  outcome: z.enum(['stopped', 'already_finished', 'kept_open', 'starting', 'unconfirmed']),
  state: z.string().optional(),
  lastError: z.string().nullable().optional()
})
export type HelperStopOutcome = z.infer<typeof HelperStopOutcome>

export type WorkerStopReceipt = {
  dispatchId: string
  state: string
  alreadySettled: boolean
  processAction: string
  close?: unknown
  lastError?: string | null
  warning?: string
  helpers?: HelperStopOutcome[]
}

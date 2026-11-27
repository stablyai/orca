import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** One helper under a stopped worker, and what its stop did. */
export const HelperStopOutcome = lazyZodSchema(() =>
  z.object({
    dispatchId: z.string(),
    creatorDispatchId: z.string(),
    outcome: z.enum(['stopped', 'already_finished', 'kept_open', 'starting', 'unconfirmed']),
    /** Set on a helper left running because the user kept this ancestor open. */
    keptOpenBy: z.string().optional(),
    state: z.string().optional(),
    lastError: z.string().nullable().optional()
  })
)
export type HelperStopOutcome = z.infer<typeof HelperStopOutcome>

/** A helper whose stop is done: it stopped, had already finished, or the user kept it open. */
export function isHelperStopDone(helper: Pick<HelperStopOutcome, 'outcome'>): boolean {
  return (
    helper.outcome === 'stopped' ||
    helper.outcome === 'already_finished' ||
    helper.outcome === 'kept_open'
  )
}

export type WorkerStopReceipt = {
  dispatchId: string
  state: string
  alreadySettled: boolean
  processAction: string
  close?: unknown
  /** How a stop settled without a proven exit, such as a start it cancelled. */
  reason?: string
  lastError?: string | null
  warning?: string
  helpers?: HelperStopOutcome[]
  /** Why helpers on the worker's host could not be stopped or listed. */
  helperStopError?: string
}

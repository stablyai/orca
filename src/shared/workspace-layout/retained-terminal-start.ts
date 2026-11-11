import { z } from 'zod'
import { parseExecutionHostId, type ExecutionHostId } from '../execution-host'

export const retainedTerminalStart = z.object({
  worktreeId: z.string().min(1),
  runtimeId: z.string().min(1),
  executionHostId: z.custom<ExecutionHostId>(
    (value) => typeof value === 'string' && parseExecutionHostId(value) !== null
  ),
  tabId: z.string().min(1),
  leafId: z.string().uuid(),
  bindingGeneration: z.number().int().nonnegative(),
  startSequence: z.number().int().positive(),
  status: z.enum(['starting', 'resuming', 'failed', 'held']),
  reason: z.string()
})

export type RetainedTerminalStart = z.infer<typeof retainedTerminalStart>

export function readRetainedTerminalStart(data: unknown): RetainedTerminalStart | null {
  const parsed = z.object({ retainedTerminalStart }).safeParse(data)
  return parsed.success &&
    (parsed.data.retainedTerminalStart.status === 'failed' ||
      parsed.data.retainedTerminalStart.status === 'held')
    ? parsed.data.retainedTerminalStart
    : null
}

/** Only the admitted start's owner can attest that its failed destination remains. */
export class RetainedTerminalStartError extends Error {
  readonly data: { retainedTerminalStart: RetainedTerminalStart }

  constructor(error: unknown, outcome: RetainedTerminalStart) {
    super(error instanceof Error ? error.message : String(error), { cause: error })
    this.name = 'RetainedTerminalStartError'
    this.data = { retainedTerminalStart: outcome }
  }
}

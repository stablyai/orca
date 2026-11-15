import { z } from 'zod'

/** The longest a host holds one watch; a client sizes its own timeout from the wait it asked for. */
export const TERMINAL_WATCH_FOCUS_MAX_WAIT_MS = 5 * 60 * 1000

/** Without `after` the host answers at once; with it, once the focused handle differs or the wait ends. */
export const TerminalWatchFocus = z.object({
  after: z.string().max(256).nullable().optional(),
  timeoutMs: z.number().int().positive().max(TERMINAL_WATCH_FOCUS_MAX_WAIT_MS).optional()
})

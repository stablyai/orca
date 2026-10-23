import { z } from 'zod'

/**
 * A user's close of a paired runtime host's session tab that never reached the host.
 *
 * The desktop prunes its mirror at once, so without a durable record a reload would forget the
 * close and the host's next snapshot would bring the tab back (STA-6224). The client replays the
 * same `session.tabs.close` a live close sends, which is why nothing here is new wire state.
 */
export type PairedTerminalTabCloseIntent = {
  /** Every host id the close hid; the first is the one sent. */
  hostTabIds: string[]
  worktreeId: string
  /** When the user closed it; the only input to the give-up bound. */
  closedAt: number
  /** The environment's pairing at the close; a re-paired host must never receive it. */
  pairingRevision?: number
  /** The user confirmed closing a pinned tab; the replay keeps that confirmation. */
  force?: true
}

/** How many unreplayed closes one environment may hold before the oldest are dropped. */
export const MAX_PAIRED_TERMINAL_TAB_CLOSE_INTENTS = 256

/** Past this the host has had a month of reconnects to hear the close. */
export const PAIRED_TERMINAL_TAB_CLOSE_INTENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export const pairedTerminalTabCloseIntentSchema: z.ZodType<PairedTerminalTabCloseIntent> = z.object(
  {
    // Why 4096: a mirrored editor tab is named by its file path, and paths outrun any short cap.
    hostTabIds: z.array(z.string().min(1).max(4096)).min(1).max(8),
    worktreeId: z.string().min(1).max(1024),
    closedAt: z.number().int().nonnegative(),
    pairingRevision: z.number().int().nonnegative().optional(),
    force: z.literal(true).optional()
  }
)

/** One intent per tab and pairing, so a repeat close of the same tab is not queued twice. */
export function pairedTerminalTabCloseIntentKey(intent: PairedTerminalTabCloseIntent): string {
  return JSON.stringify([intent.worktreeId, intent.hostTabIds[0], intent.pairingRevision ?? null])
}

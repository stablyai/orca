import { z } from 'zod'

/** Persist unacknowledged client-hosted closes and replay browser.tabClose on reconnect, preventing runtime restoration of tabs closed while unreachable. Uses existing wire state. */
export type ClientHostedBrowserCloseIntent = {
  browserPageId: string
  worktreeId: string
  /** When the user closed it; the only input to the give-up bound. */
  closedAt: number
}

export const MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS = 256

/** Expire unreplayable closes after a month of possible reconnects; the client can no longer explain retained runtime rows. */
export const CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export const clientHostedBrowserCloseIntentSchema: z.ZodType<ClientHostedBrowserCloseIntent> =
  z.object({
    browserPageId: z.string().min(1).max(256),
    worktreeId: z.string().min(1).max(1024),
    closedAt: z.number().int().nonnegative()
  })

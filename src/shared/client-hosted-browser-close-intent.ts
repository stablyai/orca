import { z } from 'zod'

/**
 * A close of a client-hosted page that its owning runtime never acknowledged.
 *
 * The runtime persists its client-hosted pages, so without this the next start would faithfully
 * restore a tab the user closed while the host was unreachable -- a resurrection that is worse
 * than the ghost row it replaced. The client records the intent instead and replays the same
 * `browser.tabClose` on reconnect, which is why nothing here is new wire state.
 */
export type ClientHostedBrowserCloseIntent = {
  browserPageId: string
  worktreeId: string
  /** When the user closed it; the only input to the give-up bound. */
  closedAt: number
}

/** How many unreplayed closes one environment may hold before the oldest are dropped. */
export const MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS = 256

/**
 * How long an unreplayable close keeps being retried. Past this the runtime has had a month of
 * reconnects to hear it, and a row it still holds is one this client can no longer explain.
 */
export const CLIENT_HOSTED_BROWSER_CLOSE_INTENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export const clientHostedBrowserCloseIntentSchema: z.ZodType<ClientHostedBrowserCloseIntent> =
  z.object({
    browserPageId: z.string().min(1).max(256),
    worktreeId: z.string().min(1).max(1024),
    closedAt: z.number().int().nonnegative()
  })

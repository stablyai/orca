/** A server whose pages need a desktop browser, but has no host lease, asks one connected desktop to start hosting (#35066). */
import { z } from 'zod'

/** Desktops that can host on request; servers ask only sockets that advertise it. */
export const BROWSER_CLIENT_HOST_REQUEST_CAPABILITY = 'browser.clientHost.request.v1' as const

export type BrowserClientHostRequestEvent = { type: 'browserHostRequested'; requestId: string }

const Identity = z.string().min(1).max(256)

export const BrowserClientHostRequestResultParams = z.object({
  requestId: Identity,
  /** The lease this desktop now holds; absent when it declines to host. */
  browserHostClientId: Identity.optional()
})
export type BrowserClientHostRequestResultParams = z.infer<
  typeof BrowserClientHostRequestResultParams
>

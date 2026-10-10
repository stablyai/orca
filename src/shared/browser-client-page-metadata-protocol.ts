import { z } from 'zod'

const Identity = z.string().min(1).max(256)
const Generation = z.number().int().min(1).max(0xffff_ffff)

export const BROWSER_CLIENT_PAGE_METADATA_METHOD = 'browser.clientHost.pageMetadata' as const

export const BrowserClientPageMetadataParams = z.object({
  browserHostClientId: Identity,
  browserHostGeneration: Generation,
  browserPageId: Identity,
  pageHostGeneration: Generation,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  url: z.string().max(8192),
  title: z.string().max(4096),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean()
})

export type BrowserClientPageMetadataParams = z.infer<typeof BrowserClientPageMetadataParams>

export const BrowserClientPageMetadataAck = z.object({ accepted: z.boolean() })
export type BrowserClientPageMetadataAck = z.infer<typeof BrowserClientPageMetadataAck>

/**
 * What the publishing renderer learns about its publish.
 *
 * `accepted: false` is not a failure — the runtime already holds a newer revision — but it is the
 * signal that separates "the runtime has this page's URL" from "the runtime is still showing the
 * URL the page was born with", so it is reported rather than discarded.
 */
export type BrowserClientPageMetadataPublishOutcome =
  | { status: 'published'; accepted: boolean }
  /** Main declined to forward it at all: untrusted sender or malformed params. */
  | { status: 'refused' }
  | { status: 'failed'; errorCode: string }

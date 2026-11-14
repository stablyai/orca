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

/** accepted:false means the runtime already has a newer revision, not failure; report it so the renderer can distinguish acknowledged URL state from the creation URL. */
export type BrowserClientPageMetadataPublishOutcome =
  | { status: 'published'; accepted: boolean }
  /** Main declined to forward it at all: untrusted sender or malformed params. */
  | { status: 'refused' }
  | { status: 'failed'; errorCode: string }

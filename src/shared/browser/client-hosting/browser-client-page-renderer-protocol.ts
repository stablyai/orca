import { z } from 'zod'

const Identity = z.string().min(1).max(256)
const Partition = z.string().min(1).max(512)
const Generation = z.number().int().min(1).max(0xffff_ffff)
const WebContentsId = z.number().int().positive()

export const BROWSER_CLIENT_PAGE_RENDERER_REQUEST_CHANNEL =
  'browser:clientPageRendererRequest' as const
export const BROWSER_CLIENT_PAGE_RENDERER_REPLY_CHANNEL = 'browser:clientPageRendererReply' as const

export const BrowserClientPageRendererIdentity = z.object({
  partition: Partition,
  browserPageId: Identity,
  pageHostGeneration: Generation
})
export type BrowserClientPageRendererIdentity = z.infer<typeof BrowserClientPageRendererIdentity>

const RendererRequestBase = z.object({
  requestId: Identity,
  page: BrowserClientPageRendererIdentity
})

export const BrowserClientPageRendererRequest = z.discriminatedUnion('type', [
  RendererRequestBase.extend({ type: z.literal('mountPage') }),
  RendererRequestBase.extend({ type: z.literal('retirePage') }),
  RendererRequestBase.extend({
    type: z.literal('rekeyPage'),
    nextPage: BrowserClientPageRendererIdentity
  })
])
export type BrowserClientPageRendererRequest = z.infer<typeof BrowserClientPageRendererRequest>

export const BrowserClientPageRendererOutcome = z.discriminatedUnion('type', [
  z.object({ type: z.literal('mounted'), webContentsId: WebContentsId }),
  z.object({ type: z.literal('retired') }),
  z.object({ type: z.literal('rekeyed') }),
  z.object({ type: z.literal('failed'), errorCode: Identity })
])
export type BrowserClientPageRendererOutcome = z.infer<typeof BrowserClientPageRendererOutcome>

const RendererReplyBase = RendererRequestBase.pick({ requestId: true, page: true })

export const BrowserClientPageRendererReply = z.discriminatedUnion('type', [
  RendererReplyBase.extend({
    type: z.literal('mounted'),
    webContentsId: WebContentsId
  }),
  RendererReplyBase.extend({ type: z.literal('retired') }),
  RendererReplyBase.extend({
    type: z.literal('rekeyed'),
    nextPage: BrowserClientPageRendererIdentity
  }),
  RendererReplyBase.extend({
    type: z.literal('failed'),
    operation: z.enum(['mountPage', 'retirePage', 'rekeyPage']),
    errorCode: Identity
  })
])
export type BrowserClientPageRendererReply = z.infer<typeof BrowserClientPageRendererReply>

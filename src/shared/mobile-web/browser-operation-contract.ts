import { z } from 'zod'
import { isMobileWebBase64 } from './protocol-token-contract'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'
import {
  isMobileWebPageBrowserNavigationUrl,
  MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH
} from './browser-url-privacy'

export const MOBILE_WEB_BROWSER_PAGE_ID_MAX_LENGTH = 512
export const MOBILE_WEB_BROWSER_URL_MAX_LENGTH = MOBILE_WEB_PAGE_BROWSER_URL_MAX_LENGTH
export const MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES = 128 * 1024
export const MOBILE_WEB_BROWSER_FRAME_MAX_CHUNKS = Math.ceil(
  MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES / MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES
)
export const MOBILE_WEB_BROWSER_FRAME_CHUNK_BASE64_MAX_LENGTH =
  Math.ceil(MOBILE_WEB_BROWSER_FRAME_CHUNK_BYTES / 3) * 4

export const MobileWebBrowserPageIdSchema = z
  .string()
  .min(1)
  .max(MOBILE_WEB_BROWSER_PAGE_ID_MAX_LENGTH)

const MobileWebBrowserTargetSchema = z
  .object({
    workspaceId: MobileWebWorkspaceIdSchema,
    pageId: MobileWebBrowserPageIdSchema
  })
  .strict()

const MobileWebBrowserCoordinateSchema = z.number().finite().min(-100_000).max(100_000)
const MobileWebBrowserDimensionSchema = z.number().finite().positive().max(10_000)
const MobileWebBrowserPointerButtonSchema = z.enum(['left', 'right'])
const MobileWebBrowserPointerModifierSchema = z.enum(['cmd', 'ctrl', 'alt', 'shift'])

export const MobileWebBrowserStreamPayloadSchema = MobileWebBrowserTargetSchema.extend({
  format: z.enum(['jpeg', 'png']),
  quality: z.number().int().min(1).max(100),
  maxWidth: z.number().int().min(1).max(2400),
  maxHeight: z.number().int().min(1).max(2160),
  viewportWidth: z.number().int().min(1).max(10_000).optional(),
  viewportHeight: z.number().int().min(1).max(10_000).optional(),
  deviceScaleFactor: z.number().finite().min(0.1).max(10).optional(),
  mobile: z.boolean().optional(),
  everyNthFrame: z.number().int().min(1).max(60),
  minFrameIntervalMs: z.number().int().min(16).max(10_000)
}).strict()

export const MobileWebBrowserNavigatePayloadSchema = MobileWebBrowserTargetSchema.extend({
  url: z
    .string()
    .min(1)
    .max(MOBILE_WEB_BROWSER_URL_MAX_LENGTH)
    .refine(isMobileWebPageBrowserNavigationUrl, 'Unsupported browser URL')
}).strict()

export const MobileWebBrowserTargetPayloadSchema = MobileWebBrowserTargetSchema

export const MobileWebBrowserPointerPayloadSchema = z.discriminatedUnion('action', [
  MobileWebBrowserTargetSchema.extend({
    action: z.literal('scroll'),
    x: MobileWebBrowserCoordinateSchema,
    y: MobileWebBrowserCoordinateSchema,
    dx: MobileWebBrowserCoordinateSchema,
    dy: MobileWebBrowserCoordinateSchema
  }).strict(),
  MobileWebBrowserTargetSchema.extend({
    action: z.literal('click'),
    x: MobileWebBrowserCoordinateSchema,
    y: MobileWebBrowserCoordinateSchema,
    button: MobileWebBrowserPointerButtonSchema,
    modifiers: z.array(MobileWebBrowserPointerModifierSchema).max(4),
    radius: z.number().finite().min(0).max(1000).optional()
  }).strict()
])

export const MobileWebBrowserKeyboardPayloadSchema = z.discriminatedUnion('action', [
  MobileWebBrowserTargetSchema.extend({
    action: z.literal('insertText'),
    text: z
      .string()
      .min(1)
      .max(32 * 1024)
  }).strict(),
  MobileWebBrowserTargetSchema.extend({
    action: z.literal('keypress'),
    key: z.enum(['Enter', 'Backspace', 'Tab', 'Escape'])
  }).strict()
])

export const MobileWebBrowserDialogPayloadSchema = MobileWebBrowserTargetSchema.extend({
  action: z.enum(['accept', 'dismiss'])
}).strict()

export const MobileWebBrowserNavigateResultSchema = z
  .object({
    url: z.string().min(1).max(MOBILE_WEB_BROWSER_URL_MAX_LENGTH)
  })
  .strict()

export const MobileWebBrowserCommandResultSchema = z.null()

const MobileWebBrowserTabStateSchema = z
  .object({
    url: z.string().max(MOBILE_WEB_BROWSER_URL_MAX_LENGTH),
    title: z.string().max(240),
    canGoBack: z.boolean(),
    canGoForward: z.boolean()
  })
  .strict()

const MobileWebBrowserFrameMetadataSchema = z
  .object({
    offsetTop: MobileWebBrowserCoordinateSchema.optional(),
    pageScaleFactor: z.number().finite().min(0).max(100).optional(),
    deviceWidth: MobileWebBrowserDimensionSchema.optional(),
    deviceHeight: MobileWebBrowserDimensionSchema.optional(),
    imageWidth: MobileWebBrowserDimensionSchema.optional(),
    imageHeight: MobileWebBrowserDimensionSchema.optional(),
    scrollOffsetX: MobileWebBrowserCoordinateSchema.optional(),
    scrollOffsetY: MobileWebBrowserCoordinateSchema.optional(),
    timestamp: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict()

const MobileWebBrowserFrameChunkSchema = z
  .object({
    type: z.literal('frameChunk'),
    frameSequence: z.number().int().nonnegative().max(0xffffffff),
    format: z.enum(['jpeg', 'png']),
    metadata: MobileWebBrowserFrameMetadataSchema,
    imageBytes: z.number().int().positive().max(MOBILE_WEB_BROWSER_FRAME_MAX_IMAGE_BYTES),
    chunkIndex: z
      .number()
      .int()
      .nonnegative()
      .max(MOBILE_WEB_BROWSER_FRAME_MAX_CHUNKS - 1),
    chunkCount: z.number().int().positive().max(MOBILE_WEB_BROWSER_FRAME_MAX_CHUNKS),
    data: z
      .string()
      .min(1)
      .max(MOBILE_WEB_BROWSER_FRAME_CHUNK_BASE64_MAX_LENGTH)
      .refine(isMobileWebBase64)
  })
  .strict()
  .superRefine((event, context) => {
    if (event.chunkIndex >= event.chunkCount) {
      context.addIssue({ code: 'custom', message: 'Browser frame chunk index is out of range' })
    }
  })

export const MobileWebBrowserEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), tab: MobileWebBrowserTabStateSchema }).strict(),
  z.object({ type: z.literal('navigation'), tab: MobileWebBrowserTabStateSchema }).strict(),
  z.object({ type: z.literal('end') }).strict(),
  z
    .object({
      type: z.literal('dialog'),
      dialogType: z.enum(['alert', 'confirm', 'prompt', 'beforeunload']),
      message: z.string().max(8192)
    })
    .strict(),
  z.object({ type: z.literal('dialogClosed') }).strict(),
  z.object({ type: z.literal('error'), message: z.string().min(1).max(1024) }).strict(),
  MobileWebBrowserFrameChunkSchema
])

export type MobileWebBrowserStreamPayload = z.infer<typeof MobileWebBrowserStreamPayloadSchema>
export type MobileWebBrowserNavigatePayload = z.infer<typeof MobileWebBrowserNavigatePayloadSchema>
export type MobileWebBrowserTargetPayload = z.infer<typeof MobileWebBrowserTargetPayloadSchema>
export type MobileWebBrowserPointerPayload = z.infer<typeof MobileWebBrowserPointerPayloadSchema>
export type MobileWebBrowserKeyboardPayload = z.infer<typeof MobileWebBrowserKeyboardPayloadSchema>
export type MobileWebBrowserDialogPayload = z.infer<typeof MobileWebBrowserDialogPayloadSchema>
export type MobileWebBrowserEvent = z.infer<typeof MobileWebBrowserEventSchema>
export type MobileWebBrowserFrameChunk = Extract<MobileWebBrowserEvent, { type: 'frameChunk' }>

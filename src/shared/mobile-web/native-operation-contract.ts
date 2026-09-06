import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

export const MOBILE_WEB_CLIPBOARD_TEXT_MAX_CHARACTERS = 128 * 1024
export const MOBILE_WEB_NATIVE_ALERT_MAX_BUTTONS = 8
export const MOBILE_WEB_NATIVE_ALERT_MAX_MESSAGE_CHARACTERS = 16 * 1024
export const MOBILE_WEB_NATIVE_ALERT_MAX_TITLE_CHARACTERS = 4096
export const MOBILE_WEB_SESSION_CHAT_DRAFT_MAX_CHARACTERS = 4096

export const MobileWebNativeAlertButtonSchema = z
  .object({
    text: z.string().max(512).optional(),
    style: z.enum(['default', 'cancel', 'destructive']).optional(),
    isPreferred: z.boolean().optional()
  })
  .strict()
export const MobileWebNativeAlertPayloadSchema = z
  .object({
    title: z.string().max(MOBILE_WEB_NATIVE_ALERT_MAX_TITLE_CHARACTERS),
    message: z.string().max(MOBILE_WEB_NATIVE_ALERT_MAX_MESSAGE_CHARACTERS).optional(),
    buttons: z
      .array(MobileWebNativeAlertButtonSchema)
      .min(1)
      .max(MOBILE_WEB_NATIVE_ALERT_MAX_BUTTONS),
    options: z
      .object({
        cancelable: z.boolean().optional(),
        userInterfaceStyle: z.enum(['unspecified', 'light', 'dark']).optional()
      })
      .strict()
      .optional()
  })
  .strict()
export const MobileWebNativeAlertResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('button'),
      buttonIndex: z
        .number()
        .int()
        .nonnegative()
        .max(MOBILE_WEB_NATIVE_ALERT_MAX_BUTTONS - 1)
    })
    .strict(),
  z.object({ kind: z.literal('dismissed') }).strict()
])

export const MobileWebHapticKindSchema = z.enum([
  'selection',
  'success',
  'error',
  'edge-bump',
  'medium-impact'
])
export const MobileWebHapticSelectionPayloadSchema = z.object({}).strict()
export const MobileWebHapticFeedbackPayloadSchema = z
  .object({ kind: MobileWebHapticKindSchema })
  .strict()
export const MobileWebHapticResultSchema = z.null()
export const MobileWebHapticSelectionResultSchema = MobileWebHapticResultSchema

export const MobileWebClipboardWritePayloadSchema = z
  .object({ text: z.string().max(MOBILE_WEB_CLIPBOARD_TEXT_MAX_CHARACTERS) })
  .strict()
export const MobileWebClipboardWriteResultSchema = z
  .object({ confirmation: z.enum(['in-app', 'system']) })
  .strict()
export const MobileWebClipboardAvailabilityPayloadSchema = z.object({}).strict()
export const MobileWebClipboardAvailabilityResultSchema = z
  .object({
    hasText: z.boolean(),
    hasImage: z.boolean()
  })
  .strict()

export const MobileWebExternalUrlSchema = z
  .string()
  .min(1)
  .max(4096)
  .transform((value, context) => {
    const url = normalizeMobileWebExternalUrl(value)
    if (!url) {
      context.addIssue({ code: 'custom', message: 'Unsupported external URL' })
      return z.NEVER
    }
    return url
  })
export const MobileWebOpenExternalPayloadSchema = z
  .object({ url: MobileWebExternalUrlSchema })
  .strict()
export const MobileWebOpenExternalResultSchema = z.null()

export const MobileWebTerminalTextScaleSchema = z.union([
  z.literal(0.5),
  z.literal(0.75),
  z.literal(1),
  z.literal(1.25),
  z.literal(1.5),
  z.literal(2)
])
export const MobileWebTerminalPreferencesPayloadSchema = z.object({}).strict()
export const MobileWebTerminalPreferencesResultSchema = z
  .object({
    textScale: MobileWebTerminalTextScaleSchema,
    autocompleteEnabled: z.boolean(),
    linkOpenMode: z.enum(['orca-browser', 'phone-browser'])
  })
  .strict()
export const MobileWebTerminalTextScaleUpdatePayloadSchema = z
  .object({ textScale: MobileWebTerminalTextScaleSchema })
  .strict()
export const MobileWebTerminalTextScaleUpdateResultSchema = z.null()
export const MobileWebTerminalCustomKeySchema = z
  .object({
    id: z.string().min(1).max(128),
    label: z.string().min(1).max(64),
    bytes: z.string().max(4096),
    enter: z.boolean()
  })
  .strict()
export const MobileWebTerminalAccessoryPreferencesPayloadSchema = z.object({}).strict()
export const MobileWebTerminalAccessoryPreferencesResultSchema = z
  .object({
    customKeys: z.array(MobileWebTerminalCustomKeySchema).max(32),
    orderedBuiltInIds: z.array(z.string().min(1).max(64)).max(64),
    visibleBuiltInIds: z.array(z.string().min(1).max(64)).max(64)
  })
  .strict()
export const MobileWebTerminalCustomKeysUpdatePayloadSchema = z
  .object({
    customKeys: z.array(MobileWebTerminalCustomKeySchema).max(32)
  })
  .strict()
export const MobileWebTerminalCustomKeysUpdateResultSchema = z.null()

const MobileWebSessionChatDraftTargetShape = {
  workspaceId: MobileWebWorkspaceIdSchema,
  tabId: z.string().min(1).max(512)
} as const
export const MobileWebSessionChatDraftReadPayloadSchema = z
  .object(MobileWebSessionChatDraftTargetShape)
  .strict()
export const MobileWebSessionChatDraftReadResultSchema = z
  .object({ text: z.string().max(MOBILE_WEB_SESSION_CHAT_DRAFT_MAX_CHARACTERS) })
  .strict()
export const MobileWebSessionChatDraftWritePayloadSchema = z
  .object({
    ...MobileWebSessionChatDraftTargetShape,
    text: z.string().max(MOBILE_WEB_SESSION_CHAT_DRAFT_MAX_CHARACTERS)
  })
  .strict()
export const MobileWebSessionChatDraftWriteResultSchema = z.null()

export type MobileWebHapticKind = z.infer<typeof MobileWebHapticKindSchema>
export type MobileWebNativeAlertPayload = z.infer<typeof MobileWebNativeAlertPayloadSchema>
export type MobileWebNativeAlertResult = z.infer<typeof MobileWebNativeAlertResultSchema>
export type MobileWebClipboardWriteResult = z.infer<typeof MobileWebClipboardWriteResultSchema>
export type MobileWebClipboardAvailability = z.infer<
  typeof MobileWebClipboardAvailabilityResultSchema
>
export type MobileWebTerminalPreferences = z.infer<typeof MobileWebTerminalPreferencesResultSchema>
export type MobileWebTerminalTextScale = z.infer<typeof MobileWebTerminalTextScaleSchema>
export type MobileWebTerminalCustomKey = z.infer<typeof MobileWebTerminalCustomKeySchema>
export type MobileWebTerminalAccessoryPreferences = z.infer<
  typeof MobileWebTerminalAccessoryPreferencesResultSchema
>
export type MobileWebSessionChatDraftReadResult = z.infer<
  typeof MobileWebSessionChatDraftReadResultSchema
>

export function normalizeMobileWebExternalUrl(value: string): string | null {
  const url = value.trim()
  if (!url || url.length > 4096) {
    return null
  }
  for (let index = 0; index < url.length; index += 1) {
    const code = url.charCodeAt(index)
    if (code <= 32 || code === 127) {
      return null
    }
  }
  try {
    // Why: mailto joins http(s) as a scheme the OS handler can open safely — markdown bodies,
    // task links and PR comments all carry them, and dropping it made those taps dead.
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:' || protocol === 'mailto:' ? url : null
  } catch {
    return null
  }
}

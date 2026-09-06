import { z } from 'zod'
import { MobileWebNativeChatTargetShape } from './native-chat-target-contract'
import { matchesMobileWebProtocolToken } from './protocol-token-contract'

export const MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT = 16
export const MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS = 256 * 1024

export const MobileWebNativeChatImageIdSchema = z
  .string()
  .refine((value) =>
    matchesMobileWebProtocolToken(value, /^native_chat_image_[a-z0-9]+_[a-f0-9]{32}$/)
  )

export const MobileWebNativeChatAttachImagePayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    source: z.enum(['library', 'files'])
  })
  .strict()
export const MobileWebNativeChatAttachImageResultSchema = z
  .object({
    status: z.enum(['accepted', 'cancelled', 'permission-denied', 'too-large']),
    attachment: z
      .object({
        reference: MobileWebNativeChatImageIdSchema,
        previewUri: z
          .string()
          .startsWith('data:image/jpeg;base64,')
          .max(MOBILE_WEB_NATIVE_CHAT_IMAGE_PREVIEW_MAX_CHARACTERS)
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((result, context) => {
    if ((result.status === 'accepted') !== Boolean(result.attachment)) {
      context.addIssue({
        code: 'custom',
        message: 'Accepted image attachments require exactly one attachment'
      })
    }
  })
export const MobileWebNativeChatPasteImagesPayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    deadline: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    references: z
      .array(MobileWebNativeChatImageIdSchema)
      .min(1)
      .max(MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT),
    // Why: a paste followed by typed text needs a trailing separator so the text cannot glue onto
    // the path. Optional is not enough on a strict page->shell schema — a shell that predates the
    // field rejects the whole request — so the page sends it only when the shell advertises
    // MOBILE_WEB_SHELL_NATIVE_CHAT_PASTE_FOLLOWED_BY_TEXT_FEATURE in `init`.
    followedByText: z.boolean().optional()
  })
  .strict()
export const MobileWebNativeChatPasteImagesResultSchema = z.object({ pasted: z.boolean() }).strict()
export const MobileWebNativeChatReleaseImagesPayloadSchema = z
  .object({
    ...MobileWebNativeChatTargetShape,
    references: z
      .array(MobileWebNativeChatImageIdSchema)
      .min(1)
      .max(MOBILE_WEB_NATIVE_CHAT_IMAGE_LIMIT)
  })
  .strict()
export const MobileWebNativeChatReleaseImagesResultSchema = z.null()

export type MobileWebNativeChatAttachImagePayload = z.infer<
  typeof MobileWebNativeChatAttachImagePayloadSchema
>
export type MobileWebNativeChatAttachImageResult = z.infer<
  typeof MobileWebNativeChatAttachImageResultSchema
>
export type MobileWebNativeChatPasteImagesPayload = z.infer<
  typeof MobileWebNativeChatPasteImagesPayloadSchema
>
export type MobileWebNativeChatReleaseImagesPayload = z.infer<
  typeof MobileWebNativeChatReleaseImagesPayloadSchema
>

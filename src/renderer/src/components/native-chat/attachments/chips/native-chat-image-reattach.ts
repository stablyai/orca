import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { NativeChatComposerImageAttachment } from './native-chat-image-attachment'

/** Missing images hold Send; offer removal because pasted images cannot always be reattached. */
export function nativeChatAttachImagesAgainReason(
  attachments: readonly NativeChatComposerImageAttachment[],
  t: Translate = translate
): string | null {
  const count = attachments.filter((attachment) => attachment.unavailableName !== undefined).length
  if (count === 0) {
    return null
  }
  return count === 1
    ? t(
        'components.native-chat.composer.removeImageToSend',
        "An image couldn't be brought back. Remove it to send."
      )
    : t(
        'components.native-chat.composer.removeImagesToSend',
        "Some images couldn't be brought back. Remove them to send."
      )
}

/** A chip still saving, or one to attach again, has no path the agent can read yet. */
export function nativeChatImagesHoldSend(
  attachments: readonly NativeChatComposerImageAttachment[]
): boolean {
  return attachments.some(
    (attachment) => attachment.pending || attachment.unavailableName !== undefined
  )
}

export function nativeChatImageSendBlock(
  attachments: readonly NativeChatComposerImageAttachment[],
  t?: Translate
): { holdsSend: boolean; reason: string | null } {
  return {
    holdsSend: nativeChatImagesHoldSend(attachments),
    reason: nativeChatAttachImagesAgainReason(attachments, t)
  }
}

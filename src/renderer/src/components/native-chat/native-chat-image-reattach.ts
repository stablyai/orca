import { translate } from '@/i18n/i18n'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

/** Why the composer can't send while it holds images that couldn't be brought back; null when it
 *  holds none. Removing always works; re-attaching only for a file, so the reason names removing. */
export function nativeChatAttachImagesAgainReason(
  attachments: readonly NativeChatComposerImageAttachment[]
): string | null {
  const count = attachments.filter((attachment) => attachment.unavailableName !== undefined).length
  if (count === 0) {
    return null
  }
  return count === 1
    ? translate(
        'components.native-chat.composer.removeImageToSend',
        "An image couldn't be brought back. Remove it to send."
      )
    : translate(
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

/** Whether the composer's images keep it from sending, and the reason to show when the user can
 *  fix it. */
export function nativeChatImageSendBlock(
  attachments: readonly NativeChatComposerImageAttachment[]
): { holdsSend: boolean; reason: string | null } {
  return {
    holdsSend: nativeChatImagesHoldSend(attachments),
    reason: nativeChatAttachImagesAgainReason(attachments)
  }
}

import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'

/** Whether this device can't send the draft now, and the reason to show when the user can act on it. */
export function nativeChatComposerSendHold(args: {
  /** The input is disabled here, or pasted text is still being saved. */
  held: boolean
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  structuredTransport?: NativeChatStructuredComposerTransport
}): { sendHeld: boolean; sendBlockedReason: string | null } {
  const { held, imageAttachments, structuredTransport } = args
  const imageBlock = nativeChatImageSendBlock(imageAttachments)
  return {
    sendHeld:
      held ||
      structuredTransport?.sendOut === true ||
      imageBlock.holdsSend ||
      structuredTransport?.sendBlockedReason !== undefined,
    sendBlockedReason: imageBlock.reason ?? structuredTransport?.sendBlockedReason ?? null
  }
}

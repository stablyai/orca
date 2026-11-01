import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat-follow-up-behavior'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { nativeChatImageSendBlock } from './native-chat-image-reattach'

export type NativeChatComposerSendState = {
  /** Why Send is disabled, when the user can do something about it. */
  sendBlockedReason: string | null
  /** Nothing may be sent yet: an upload, a paste being saved, or the host holds it. */
  sendHeld: boolean
  /** The draft holds text or images: while the agent works, Send takes Stop's place. */
  hasDraft: boolean
  sendButtonDisabled: boolean
  /** While the agent works: what Cmd/Ctrl+Enter would do instead of a plain send, when it differs. */
  alternateSend: NativeChatFollowUpBehavior | undefined
}

/** What the composer's Send/Stop button offers now, and whether it can be pressed. */
export function nativeChatComposerSendState(input: {
  draft: string
  messageDelivery: boolean
  imageAttachments: readonly NativeChatComposerImageAttachment[]
  pastedTextSaving: boolean
  disabled: boolean
  structuredTransport: NativeChatStructuredComposerTransport | undefined
  editSession: { canSave: boolean } | undefined
  isWorking: boolean
  canStop: boolean
}): NativeChatComposerSendState {
  const { structuredTransport: transport } = input
  const imageBlock = nativeChatImageSendBlock(input.imageAttachments)
  const sendHeld =
    input.pastedTextSaving ||
    input.disabled ||
    transport?.sendOut === true ||
    imageBlock.holdsSend ||
    transport?.sendBlockedReason !== undefined
  const hasDraft = input.draft.trim() !== '' || input.imageAttachments.length > 0
  // Like Enter, a typed draft sends while the agent works; only an empty one offers Stop.
  const sendButtonDisabled = input.editSession
    ? sendHeld || !input.editSession.canSave
    : input.isWorking && !hasDraft
      ? !input.canStop
      : sendHeld || !hasDraft
  // The send's own resolver, so the hint withdraws wherever Cmd/Ctrl+Enter would send no differently.
  const followUp = transport?.sendFollowUp
  return {
    sendBlockedReason: imageBlock.reason ?? transport?.sendBlockedReason ?? null,
    sendHeld,
    hasDraft,
    sendButtonDisabled,
    alternateSend:
      input.messageDelivery && !input.editSession && followUp?.offersChoice
        ? followUp.action === 'queue'
          ? 'steer'
          : 'queue'
        : undefined
  }
}

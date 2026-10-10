import type { NativeChatComposerImageAttachment } from '../native-chat/NativeChatComposerField'

export const TERMINAL_IMAGE_ATTACHMENT_EVENT = 'orca-terminal-image-attachment'

export type TerminalImageAttachmentRequest = {
  attachment: NativeChatComposerImageAttachment
  fullSizePreviewUrl?: string
  cancel: () => void
  isCurrent: () => boolean
  attach: () => Promise<boolean>
}

export function requestTerminalImageAttachment(
  container: HTMLElement,
  request: TerminalImageAttachmentRequest
): boolean {
  return !container.dispatchEvent(
    new CustomEvent(TERMINAL_IMAGE_ATTACHMENT_EVENT, { detail: request, cancelable: true })
  )
}

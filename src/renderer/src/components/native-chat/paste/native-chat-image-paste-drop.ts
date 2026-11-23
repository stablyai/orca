import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { translate } from '@/i18n/i18n'

/** Why a pasted image that reached the save step did not end up in the draft. */
export type NativeChatImagePasteDropCause =
  /** The user removed its chip, or closed the chat, before the save finished. */
  | 'chip-removed'
  /** The paste carried an image but the clipboard had none when it was read. */
  | 'clipboard-empty'
  | 'save-failed'
  /** The chat moved to another workspace or host while the image saved. */
  | 'owner-changed'
  /** No chip could be shown and the composer could no longer take the image. */
  | 'composer-closed'

/** These drops were silent, so a lost paste could not be traced afterwards. */
export function recordNativeChatImagePasteDropped(cause: NativeChatImagePasteDropCause): void {
  recordRendererCrashBreadcrumb('native_chat_image_paste_dropped', { cause })
}

export function nativeChatImagePasteFailedNotice(): string {
  return translate('components.native-chat.composer.imagePasteFailed', 'Image paste failed.')
}

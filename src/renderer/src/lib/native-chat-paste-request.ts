import { translate } from '@/i18n/i18n'
import { OS_FILE_DROP_OWNER_ATTRIBUTE } from '../../../shared/native-file-drop-preparation'

export const NATIVE_CHAT_PASTE_REQUEST_EVENT = 'orca-native-chat-paste-request'
export const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

export function findNativeChatPasteOwner(target: EventTarget | null): Element | null {
  const card = target instanceof Element ? target.closest('[data-queued-message-editor]') : null
  return card?.hasAttribute(OS_FILE_DROP_OWNER_ATTRIBUTE) ? card : null
}

export function findNativeChatPasteField(
  target: EventTarget | null,
  root = target instanceof Element ? target.closest(NATIVE_CHAT_ROOT_SELECTOR) : null
): HTMLTextAreaElement | null {
  const card = findNativeChatPasteOwner(target)
  return card?.isConnected && root?.contains(card) ? card.querySelector('textarea') : null
}

/** Asks a mounted chat input owner to paste; left unclaimed when no input can take it. */
export class NativeChatPasteRequest extends Event {
  constructor(readonly clipboardEvent?: ClipboardEvent) {
    super(NATIVE_CHAT_PASTE_REQUEST_EVENT, { cancelable: true })
  }
}

export function nativeChatPasteUnavailableNotice(): string {
  return translate(
    'components.native-chat.composer.pasteUnavailable',
    "Can't paste — this chat isn't accepting input right now."
  )
}

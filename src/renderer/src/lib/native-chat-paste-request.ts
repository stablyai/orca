import { translate } from '@/i18n/i18n'

export const NATIVE_CHAT_PASTE_REQUEST_EVENT = 'orca-native-chat-paste-request'
export const NATIVE_CHAT_ROOT_SELECTOR = '[data-native-chat-root="true"]'

/** Asks a mounted chat root to paste the clipboard; left unclaimed when no chat input can take it. */
export class NativeChatPasteRequest extends Event {
  constructor() {
    super(NATIVE_CHAT_PASTE_REQUEST_EVENT, { cancelable: true })
  }
}

export function nativeChatPasteUnavailableNotice(): string {
  return translate(
    'components.native-chat.composer.pasteUnavailable',
    "Can't paste — this chat isn't accepting input right now."
  )
}

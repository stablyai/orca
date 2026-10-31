import { toast } from 'sonner'
import {
  NativeChatPasteRequest,
  NATIVE_CHAT_ROOT_SELECTOR,
  nativeChatPasteUnavailableNotice
} from '@/lib/native-chat-paste-request'
import { paneIsCoveredByNativeChat } from './native-chat-covered-pane'

/** Route paste to this leaf’s chat; an unready input refuses visibly so bytes cannot reach its hidden terminal. */
export function requestNativeChatCoverPaste(pane: { container: Element }): boolean {
  if (!paneIsCoveredByNativeChat(pane)) {
    return false
  }
  const request = new NativeChatPasteRequest()
  pane.container.querySelector(NATIVE_CHAT_ROOT_SELECTOR)?.dispatchEvent(request)
  if (!request.defaultPrevented) {
    toast.error(nativeChatPasteUnavailableNotice())
  }
  return true
}

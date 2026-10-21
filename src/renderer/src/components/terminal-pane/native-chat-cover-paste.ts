import { toast } from 'sonner'
import {
  NativeChatPasteRequest,
  NATIVE_CHAT_ROOT_SELECTOR,
  nativeChatPasteUnavailableNotice
} from '@/lib/native-chat-paste-request'
import { paneIsCoveredByNativeChat } from './native-chat-covered-pane'

/**
 * Hands a paste aimed at a chat-covered pane to that pane's chat. Returns false
 * only when no chat covers the pane; a chat with no input ready refuses visibly
 * so the paste never falls through to the hidden terminal.
 */
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

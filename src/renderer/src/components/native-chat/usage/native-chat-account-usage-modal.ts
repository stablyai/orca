import { useAppStore } from '@/store'
import type { NativeChatSessionModalRequest } from '../session/native-chat-session-modal-request'

/** The chat `/usage` was typed in; the modal reads the account that chat runs on. */
export function openNativeChatAccountUsageModal(request: NativeChatSessionModalRequest): void {
  useAppStore.getState().openModal('chat-account-usage', {
    sessionId: request.sessionId,
    target: request.target
  })
}

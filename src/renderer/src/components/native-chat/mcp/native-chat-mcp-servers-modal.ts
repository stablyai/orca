import { useAppStore } from '@/store'
import type { NativeChatSessionModalRequest } from '../session/native-chat-session-modal-request'

/** The chat `/mcp` was typed in; the modal manages the servers that chat's agent connects. */
export function openNativeChatMcpServersModal(request: NativeChatSessionModalRequest): void {
  useAppStore.getState().openModal('chat-mcp-servers', {
    sessionId: request.sessionId,
    target: request.target
  })
}

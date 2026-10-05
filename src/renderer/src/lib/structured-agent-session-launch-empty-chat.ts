import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../shared/structured-agent-session-projection'
import { getStructuredAgentSessionOutbox } from '@/components/native-chat/structured-agent-session-outbox-storage'
import { readNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { readNativeChatAttachmentCache } from '@/components/native-chat/use-native-chat-composer-attachments'

/** A starting chat is empty until its user sends into it or puts text or images in its composer;
 *  after that it is theirs, and another request never goes into it. */
export function isStructuredLaunchChatEmpty(sessionId: string): boolean {
  const paneKey = structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
  return (
    getStructuredAgentSessionOutbox(sessionId).length === 0 &&
    readNativeChatDraftCache(paneKey).trim() === '' &&
    readNativeChatAttachmentCache(paneKey).length === 0
  )
}

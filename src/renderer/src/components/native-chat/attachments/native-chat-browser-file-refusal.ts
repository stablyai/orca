import type { AgentSessionWriteNoticePart } from '../../../../../shared/agent-session/failures/agent-session-write-notice-copy'
import { nativeChatStagedFileHolderScopes } from '../drafts/native-chat-draft-attachment-staging'
import {
  structuredAgentSessionDraftScopeKey,
  structuredAgentSessionIdOfDraftScope
} from '../drafts/native-chat-draft-scope'
import { noteNativeChatFilesHeldElsewhere } from '../composer/controls/native-chat-held-elsewhere-notice'
import { nativeChatBrowserFileRefusalParts } from './native-chat-browser-file-references'

/**
 * Word a whole-message refusal of `references` in chat `sessionId`. A file another draft holds now is
 * intact there: the chat's persistent notice says where (with a way to open it), and it is not called
 * expired or missing. The returned parts word only the rest; null when nothing else is left to say.
 */
export function nativeChatBrowserFileRefusal(
  references: readonly string[],
  sessionId?: string
): AgentSessionWriteNoticePart[] | null {
  const own = sessionId === undefined ? undefined : structuredAgentSessionDraftScopeKey(sessionId)
  const owners: (string | undefined)[] = []
  const rest: string[] = []
  for (const reference of references) {
    const holders = nativeChatStagedFileHolderScopes(reference)
    if (own === undefined || holders.length === 0 || holders.includes(own)) {
      rest.push(reference)
    } else {
      owners.push(structuredAgentSessionIdOfDraftScope(holders[0]) ?? undefined)
    }
  }
  if (sessionId !== undefined) {
    const ownerSessionId = owners.find((owner) => owner !== undefined)
    noteNativeChatFilesHeldElsewhere(
      sessionId,
      owners.length ? { count: owners.length, ...(ownerSessionId ? { ownerSessionId } : {}) } : null
    )
  }
  return rest.length ? nativeChatBrowserFileRefusalParts(rest) : null
}

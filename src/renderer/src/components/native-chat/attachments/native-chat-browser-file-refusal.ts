import type { AgentSessionWriteNoticePart } from '../../../../../shared/agent-session/failures/agent-session-write-notice-copy'
import { translate } from '@/i18n/i18n'
import { nativeChatStagedFileHolderScopes } from '../drafts/native-chat-draft-attachment-staging'
import {
  structuredAgentSessionDraftScopeKey,
  structuredAgentSessionIdOfDraftScope
} from '../drafts/native-chat-draft-scope'
import {
  noteNativeChatFilesHeldElsewhere,
  type NativeChatHeldElsewhere
} from '../composer/controls/native-chat-held-elsewhere-notice'
import { nativeChatBrowserFileRefusalParts } from './native-chat-browser-file-references'

/**
 * Split `references` into files another chat's draft holds now (intact there) and the rest. A chat is
 * named only when one chat's draft holds them all; a pending creation's draft is no chat to name.
 */
function splitHeldElsewhere(
  references: readonly string[],
  sessionId: string | undefined
): { held: NativeChatHeldElsewhere | null; rest: string[] } {
  const own = sessionId === undefined ? undefined : structuredAgentSessionDraftScopeKey(sessionId)
  const ownerScopes = new Set<string>()
  let count = 0
  const rest: string[] = []
  for (const reference of references) {
    const holders = nativeChatStagedFileHolderScopes(reference)
    if (own === undefined || holders.length === 0 || holders.includes(own)) {
      rest.push(reference)
    } else {
      count += 1
      ownerScopes.add(holders[0])
    }
  }
  if (count === 0) {
    return { held: null, rest }
  }
  if (ownerScopes.size > 1) {
    return { held: { count, severalChats: true }, rest }
  }
  const [ownerScope] = ownerScopes
  const ownerSessionId = structuredAgentSessionIdOfDraftScope(ownerScope) ?? undefined
  return { held: { count, ...(ownerSessionId ? { ownerSessionId } : {}) }, rest }
}

/** The queued-card Save toast's account of files another chat's draft holds. */
function queuedEditHeldElsewhereSentence(held: NativeChatHeldElsewhere): string {
  return held.severalChats
    ? translate(
        'components.native-chat.composer.queuedEditHeldInOtherChats',
        "Some attachments are in other chats' drafts."
      )
    : translate(
        'components.native-chat.composer.queuedEditHeldInAnotherChat',
        "{{count}} attachments are in another chat's draft.",
        {
          count: held.count,
          defaultValue_one: "{{count}} attachment is in another chat's draft."
        }
      )
}

/**
 * Word a whole-write refusal of `references` in chat `sessionId`. A file another draft holds now is
 * intact there, and it is never called expired or missing. For a send, the chat's persistent notice
 * says where (with a way to open it) and the returned parts word only the rest, or null when nothing
 * else is left to say. A queued card's Save is not a send: its own words say all of it, and the
 * composer's "Not sent" notice is left alone.
 */
export function nativeChatBrowserFileRefusal(
  references: readonly string[],
  sessionId?: string,
  write: 'send' | 'queued-edit' = 'send'
): AgentSessionWriteNoticePart[] | null {
  const { held, rest } = splitHeldElsewhere(references, sessionId)
  if (write === 'queued-edit') {
    return [
      ...(held ? [{ text: queuedEditHeldElsewhereSentence(held) }] : []),
      ...(rest.length
        ? nativeChatBrowserFileRefusalParts(rest, 'notDoneQueuedEdit')
        : ['notDoneQueuedEdit' as const])
    ]
  }
  if (sessionId !== undefined) {
    noteNativeChatFilesHeldElsewhere(sessionId, held)
  }
  return rest.length ? nativeChatBrowserFileRefusalParts(rest) : null
}

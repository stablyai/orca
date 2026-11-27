import type { AgentSessionWriteNoticePart } from '../../../../../shared/agent-session/failures/agent-session-write-notice-copy'
import { translate } from '@/i18n/i18n'
import { nativeChatStagedFileDraftHolderScopes } from '../drafts/native-chat-draft-attachment-staging'
import {
  structuredAgentSessionDraftScopeKey,
  structuredAgentSessionIdOfDraftScope
} from '../drafts/native-chat-draft-scope'
import {
  noteNativeChatFilesHeldElsewhere,
  type NativeChatHeldElsewhere,
  type NativeChatHeldElsewhereRecord
} from '../composer/controls/native-chat-held-elsewhere-notice'
import { nativeChatBrowserFileRefusalParts } from './native-chat-browser-file-references'

/**
 * Split `references` by what the drafts hold now: files another chat's draft holds (intact there),
 * files no draft holds any more (`gone`), and the rest (this chat's own, or with no chat to ask). A
 * chat is named only when one chat's draft holds them all; a pending creation's draft is no chat to
 * name. Custody is the draft's: a send's lease keeps an original readable but owns no chat.
 */
function splitHeldElsewhere(
  references: readonly string[],
  sessionId: string | undefined
): { held: NativeChatHeldElsewhere | null; heldReferences: string[]; rest: string[] } {
  const own = sessionId === undefined ? undefined : structuredAgentSessionDraftScopeKey(sessionId)
  const ownerScopes = new Set<string>()
  const heldReferences: string[] = []
  const rest: string[] = []
  for (const reference of references) {
    const holders = nativeChatStagedFileDraftHolderScopes(reference)
    if (own === undefined || holders.length === 0 || holders.includes(own)) {
      rest.push(reference)
    } else {
      heldReferences.push(reference)
      ownerScopes.add(holders[0])
    }
  }
  const count = heldReferences.length
  if (count === 0) {
    return { held: null, heldReferences, rest }
  }
  if (ownerScopes.size > 1) {
    return { held: { count, severalChats: true }, heldReferences, rest }
  }
  const [ownerScope] = ownerScopes
  const ownerSessionId = structuredAgentSessionIdOfDraftScope(ownerScope) ?? undefined
  return {
    held: { count, ...(ownerSessionId ? { ownerSessionId } : {}) },
    heldReferences,
    rest
  }
}

/**
 * What the drafts say now about files a refused message of chat `sessionId` named: who holds them
 * elsewhere, if anyone still does, and which of them nobody holds any more (`gone`: they have to be
 * attached again). Files back in this chat's own draft are neither.
 */
export function nativeChatHeldElsewhereNow(
  references: readonly string[],
  sessionId: string
): { held: NativeChatHeldElsewhere | null; gone: string[] } {
  const own = structuredAgentSessionDraftScopeKey(sessionId)
  const { held, rest } = splitHeldElsewhere(references, sessionId)
  return {
    held,
    gone: rest.filter(
      (reference) => !nativeChatStagedFileDraftHolderScopes(reference).includes(own)
    )
  }
}

const shown = new WeakMap<
  NativeChatHeldElsewhereRecord,
  { sessionId: string; version: number; now: ReturnType<typeof nativeChatHeldElsewhereNow> }
>()

/**
 * `nativeChatHeldElsewhereNow` for a shown notice, read once per ownership `version` of the drafts:
 * the same result until the record or what the drafts hold changes.
 */
export function nativeChatHeldElsewhereAt(
  record: NativeChatHeldElsewhereRecord,
  sessionId: string,
  version: number
): ReturnType<typeof nativeChatHeldElsewhereNow> {
  const cached = shown.get(record)
  if (cached?.sessionId === sessionId && cached.version === version) {
    return cached.now
  }
  const now = nativeChatHeldElsewhereNow(record.references, sessionId)
  shown.set(record, { sessionId, version, now })
  return now
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
  const { held, heldReferences, rest } = splitHeldElsewhere(references, sessionId)
  if (write === 'queued-edit') {
    return [
      ...(held ? [{ text: queuedEditHeldElsewhereSentence(held) }] : []),
      ...(rest.length
        ? nativeChatBrowserFileRefusalParts(rest, 'notDoneQueuedEdit')
        : ['notDoneQueuedEdit' as const])
    ]
  }
  if (sessionId !== undefined) {
    noteNativeChatFilesHeldElsewhere(sessionId, heldReferences)
  }
  return rest.length ? nativeChatBrowserFileRefusalParts(rest) : null
}

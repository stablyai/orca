import { agentJournalLinkageFields } from '../../../src/shared/agent-session-journal-producer'
import { parseAgentJournalItemKey } from '../../../src/shared/agent-session-journal-item-key'
import type { AgentJournalMessageItem } from '../../../src/shared/agent-session-journal-types'
import type { JournalReplacementItem } from '../../../src/main/native-chat/agent-session-journal/journal-epoch-replacement'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'

// What a user does next with a chat a released build wrote: edit a card it queued (the first write,
// over a key the old rows hold), send, and rewind to before that send, which saves every kept message
// and card again. This build and a shipped build run the same steps.

const FENCE = 1

export type ContinuedJournal = Pick<
  AgentSessionJournal,
  | 'queuedMessages'
  | 'appendSubmission'
  | 'resolveDispatch'
  | 'replaceEpochItems'
  | 'snapshot'
  | 'itemBody'
  | 'itemProvenance'
>

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

/** The first write: an edit of a card the release queued and still holds. */
export async function editReleasedCard(journal: ContinuedJournal): Promise<void> {
  const card = journal.queuedMessages.list().find((entry) => entry.messageId === 'card-2')
  if (!card) {
    throw new Error('the release queued no card-2')
  }
  const edited = await journal.queuedMessages.update({
    messageId: 'card-2',
    expectedBodyFingerprint: card.fingerprint,
    text: 'second, edited after the upgrade'
  })
  if (edited.status !== 'updated') {
    throw new Error(`the card edit was ${edited.status}`)
  }
}

export async function sendAfterUpgrade(journal: ContinuedJournal): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: 'after-upgrade',
    payloadFingerprint: 'fp-after-upgrade',
    body: message('after the upgrade'),
    fence: FENCE,
    handoverRecorded: true,
    origin: 'client',
    source: { kind: 'user' }
  })
  await journal.resolveDispatch({
    clientMessageId: 'after-upgrade',
    fence: FENCE,
    state: 'accepted',
    providerIdentity: null
  })
}

/** A rewind to before the send: every message the release wrote is kept, as rewind keeps them. */
export async function rewindReleasedChat(
  journal: ContinuedJournal,
  keptItemIds: ReadonlySet<string>
): Promise<void> {
  const kept = journal
    .snapshot()
    .items.filter((item) => keptItemIds.has(item.itemId))
    .map(({ itemId, observedAt, turnScope, ...linkage }): JournalReplacementItem => {
      const body = journal.itemBody(itemId)
      const identity = parseAgentJournalItemKey(itemId)
      if (!body || !identity) {
        throw new Error(`no kept item ${itemId}`)
      }
      const { ownerFence, executionOwner, ...echo } = journal.itemProvenance(itemId)
      return {
        identity,
        ...echo,
        body,
        observedAt,
        ...(turnScope ? { turnScope } : {}),
        ownerFence: ownerFence ?? 0,
        ...(executionOwner === undefined ? {} : { executionOwner }),
        ...agentJournalLinkageFields(linkage)
      }
    })
  if (kept.length !== keptItemIds.size) {
    throw new Error('a kept item is missing from the chat')
  }
  await journal.replaceEpochItems('handle_forked', FENCE, kept)
}

import type { AgentJournalMessageItem } from '../../../src/shared/agent-session-journal-types'
import { QUEUED_MESSAGE_PAUSED_SEND_FAILED } from '../../../src/shared/agent-session-queued-message-wire'
import type { AgentSessionJournal } from '../../../src/main/native-chat/agent-session-journal/journal-store'

// Queue edits as each release's queue writes them: two cards, an edit, a move, a hold and a
// withdrawal. Releases before cards moved into the chat's rows kept them in a table of their own,
// with no edit or move.

type TableQueue = {
  insert: (input: {
    messageId: string
    body: AgentJournalMessageItem
    fingerprint: string
    hostInstance: string
  }) => Promise<unknown>
  hold: (input: { messageIds: readonly string[]; reason: 'send_failed' }) => Promise<void>
  withdraw: (input: { messageIds: readonly string[]; settledByOp: string }) => Promise<unknown>
}

/** A table-backed queue answers an operation's replay from its stored rows. */
function isTableQueue(queue: unknown): queue is TableQueue {
  return typeof queue === 'object' && queue !== null && 'receipts' in queue
}

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

export async function queueReleasedCards(
  queue: AgentSessionJournal['queuedMessages']
): Promise<void> {
  const table: unknown = queue
  if (isTableQueue(table)) {
    const card = { fingerprint: 'fp-card', hostInstance: 'host-instance-1' }
    await table.insert({ ...card, messageId: 'card-1', body: message('later') })
    await table.insert({ ...card, messageId: 'card-2', body: message('second') })
    await table.hold({ messageIds: ['card-2'], reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
    await table.withdraw({ messageIds: ['card-1'], settledByOp: 'withdraw-card-1' })
    return
  }
  const first = await queue.insert({
    messageId: 'card-1',
    body: message('later'),
    options: { model: 'model-1' }
  })
  await queue.insert({ messageId: 'card-2', body: message('second') })
  await queue.update({
    messageId: 'card-1',
    expectedBodyFingerprint: first.fingerprint,
    text: 'later, edited'
  })
  await queue.move({ messageId: 'card-2', beforeMessageId: 'card-1' })
  await queue.hold({ messageIds: ['card-2'], reason: QUEUED_MESSAGE_PAUSED_SEND_FAILED })
  await queue.withdraw(['card-1'])
}

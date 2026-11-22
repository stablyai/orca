import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/journal/agent-session-message-source'
import type { BotItemNoteEntry } from '../../../../../../shared/bots/bot-item-note'
import type { NativeChatTranscriptRowContext } from '../../messages/rows/NativeChatTranscriptRow'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { NativeChatTranscriptRowStack } from './NativeChatTranscriptItems'

const start = Date.parse('2026-11-20T15:14:00Z')
let clock = start
const row = (
  id: string,
  role: NativeChatMessage['role'],
  text: string,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage => ({
  id,
  role,
  timestamp: (clock += 30_000),
  source: 'transcript',
  blocks: text ? [{ type: 'text', text }] : [],
  ...extra
})

const workerUpdate = (id: string, name: string): NativeChatMessage =>
  row(id, 'user', 'Pushed the fix and the checks pass.', {
    from: {
      kind: 'agent',
      senders: [
        {
          party: { address: `term_${id}`, terminalHandle: `term_${id}`, orcaSessionId: null },
          name,
          agent: 'claude',
          relation: 'worker'
        }
      ],
      orchestration: { message: 'mail-notice', mailbox: 'term_bot', dispatchId: null, messages: [] }
    } satisfies AgentMessageSource
  })

const itemMail: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: {
    message: 'mail-notice',
    mailbox: 'term_bot',
    dispatchId: null,
    messages: [{ messageId: 'msg_item_1', runId: 'r', from: 'orca:items' }]
  }
}

const item = (number: number, title: string, status: BotItemNoteEntry['status']) => ({
  uid: `item-${number}`,
  number,
  title,
  status
})

const note = (id: string, by: 'bot' | 'owner', entries: BotItemNoteEntry[]): NativeChatMessage =>
  row(id, 'system', '', { botItemNote: { noteId: id, by, entries } })

const commentBox = item(1, 'Item comment box: @ and / pickers in the composer', 'working')
const send = item(2, 'send --to bot:<self> without --chat lands in Home', 'working')
const stop = item(3, 'Workers that stop (quota error or silent exit) never report', 'working')

const messages: NativeChatMessage[] = [
  row('ask', 'user', 'Can you split the item comment work into its own PR?'),
  row('reply-1', 'assistant', 'On it. I asked two workers to take the pickers and the mail turn.'),
  workerUpdate('w1', 'Item comment box @ and / pickers'),
  workerUpdate('w2', 'Agent group room mail-turn @mention routing'),
  note('n1', 'bot', [{ ...send, event: 'commented', text: 'Repro found.' }]),
  note('n2', 'bot', [
    { ...commentBox, status: 'done', event: 'status', from: 'working', to: 'done' }
  ]),
  note('n3', 'bot', [{ ...stop, event: 'commented', text: 'Still open.' }]),
  note('n4', 'bot', [
    { ...commentBox, status: 'needs_you', event: 'status', from: 'working', to: 'needs_you' }
  ]),
  row('reply-2', 'assistant', 'Moved to a new PR and asked you about the picker item.'),
  row('mail', 'user', '', { from: itemMail }),
  note('o1', 'owner', [
    { ...send, event: 'status', from: 'planned', to: 'working' },
    { ...send, event: 'commented', text: 'Yes, drop it' }
  ]),
  row('reply-3', 'assistant', 'Dropped it from the PR.')
]
const turnKeys = ['ask', 'ask', 'w1', 'w2', 'w2', 'w2', 'w2', 'w2', 'w2', 'mail', 'mail', 'mail']

const slots = buildNativeChatTranscriptSlots({
  messages,
  turnKeys,
  liveTurnKey: undefined,
  receipts: new Map(),
  turnStatuses: {
    active: null,
    completedByTurn: { ask: { startedAt: start, thinking: false, workedSeconds: 141 } }
  },
  turnDiffs: new Map(),
  expandedTurnKeys: new Set(),
  isWorking: false,
  lifecycleWorking: false
})

const context: NativeChatTranscriptRowContext = {
  expandSignal: false,
  revealedDiff: null,
  taskListPredecessors: new Map(),
  expandedTurnIds: new Set(),
  onToggleExpandedTurn: () => {},
  onScrollMessageToTop: () => {},
  readerAtEnd: () => true,
  onRevealDiff: () => {}
}

/** A bot chat's mix: your message, replies, worker updates, item lines, and your item move with a comment. */
export const activityMix = defineFixture({
  width: 720,
  render: () => (
    <div className="bg-chat-pane p-4">
      <NativeChatTranscriptRowStack slots={slots} context={context} />
    </div>
  )
})

import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BotItemNoteEntry, BotItemNoteView } from '../../../../../shared/bots/bot-item-note'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { buildNativeChatTranscriptSlots } from '../conversation/slots/native-chat-transcript-slots'
import { nativeChatSlotKey } from '../conversation/slots/native-chat-transcript-slot-selection'
import {
  NativeChatTranscriptRow,
  type NativeChatTranscriptRowContext
} from '../messages/rows/NativeChatTranscriptRow'
import { NATIVE_CHAT_ROW_GAP_PX } from '../viewport/virtualization/native-chat-row-height-estimate'
import { NativeChatBotItemNoteRow } from './NativeChatBotItemNoteRow'

const at = Date.parse('2026-11-14T15:14:00Z')
const item = (number: number, title: string, status: BotItemNoteEntry['status']) => ({
  uid: `item-${number}`,
  number,
  title,
  status
})
const rn = item(1, 'Release notes for 1.4.233', 'planned')
const win = item(2, 'Windows path casing audit', 'planned')
const fl = item(3, 'Flaky test sweep follow-ups', 'planned')
const sd = item(4, 'Share dialog', 'working')
const sl = item(5, 'Share links: view-only by default?', 'needs_you')

function Rows({ notes }: { notes: BotItemNoteView[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3 bg-chat-pane p-4">
      {notes.map((note) => (
        <NativeChatBotItemNoteRow key={note.noteId} note={note} timestamp={at} />
      ))}
    </div>
  )
}

const botNote = (noteId: string, entries: BotItemNoteEntry[]): BotItemNoteView => ({
  noteId,
  by: 'bot',
  entries
})

function AgentWrites(): React.JSX.Element {
  return (
    <Rows
      notes={[
        botNote(
          'a',
          [rn, win, fl].map((entry) => ({ ...entry, event: 'made' as const }))
        ),
        botNote('b', [
          {
            ...sl,
            event: 'commented',
            text: '**Suggestions:** agreed. Nora’s review asks which default new share links get.'
          },
          { ...sl, event: 'status', from: 'working', to: 'needs_you' }
        ]),
        botNote('c', [{ ...sd, event: 'commented', text: 'Dialog copy is in; tests next.' }]),
        botNote('d', [
          { ...win, status: 'working', event: 'status', from: 'planned', to: 'working' }
        ]),
        botNote('e', [
          {
            ...item(6, 'Connector token refresh fix', 'done'),
            event: 'status',
            from: 'working',
            to: 'done',
            note: 'Merged and live in all 12 cells'
          }
        ]),
        botNote('f', [
          {
            ...item(7, 'Old onboarding copy pass', 'canceled'),
            event: 'status',
            from: 'planned',
            to: 'canceled',
            note: 'The new onboarding replaces it'
          }
        ]),
        botNote(
          'g',
          [rn, fl].map((entry) => ({ ...entry, event: 'commented' as const, text: 'Rebased.' }))
        )
      ]}
    />
  )
}

export const botWrites = defineFixture({ width: 680, render: () => <AgentWrites /> })

export const botWritesNarrow = defineFixture({ width: 340, render: () => <AgentWrites /> })

const move = (
  noteId: string,
  to: BotItemNoteEntry['status'],
  from: BotItemNoteEntry['status']
): BotItemNoteView => ({
  noteId,
  by: 'owner',
  entries: [{ ...sd, status: to, event: 'status', from, to }]
})

export const ownerChanges = defineFixture({
  width: 680,
  render: () => (
    <Rows
      notes={[
        move('m1', 'working', 'planned'),
        {
          noteId: 'm2',
          by: 'owner',
          entries: [
            {
              ...item(6, 'Connector fix rollout', 'done'),
              event: 'status',
              from: 'needs_you',
              to: 'done'
            }
          ]
        },
        {
          noteId: 'm3',
          by: 'owner',
          entries: [
            {
              ...item(8, 'Memory spike on long chats', 'canceled'),
              event: 'status',
              from: 'needs_you',
              to: 'canceled',
              note: 'Fixed upstream in 1.4.232'
            }
          ]
        },
        {
          noteId: 'm4',
          by: 'owner',
          entries: [rn, win, fl, sd].map((entry) => ({
            ...entry,
            status: 'done' as const,
            event: 'status' as const,
            from: 'working' as const,
            to: 'done' as const
          }))
        },
        {
          noteId: 'm5',
          by: 'owner',
          entries: [{ ...sl, event: 'commented', text: 'View-only. Make edit a per-link switch.' }]
        }
      ]}
    />
  )
})

const run: BotItemNoteView = {
  ...move('r1', 'planned', 'working'),
  run: [
    move('r1', 'planned', 'working'),
    move('r2', 'working', 'planned'),
    move('r3', 'done', 'working'),
    move('r4', 'working', 'done'),
    move('r5', 'needs_you', 'working')
  ]
}

export const quickChanges = defineFixture({
  width: 680,
  render: () => <Rows notes={[run]} />
})

export const quickChangesOpen = defineFixture({
  width: 680,
  render: () => <Rows notes={[run]} />,
  interact: async (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-expanded]')?.click()
  }
})

export const longTextNarrow = defineFixture({
  width: 420,
  render: () => (
    <Rows
      notes={[
        {
          noteId: 'l1',
          by: 'bot',
          entries: [
            {
              ...item(
                9,
                'Rework the connector token refresh so paired servers renew before expiry',
                'working'
              ),
              event: 'commented',
              text: 'Both workers finished; PR #41230 opened with the refresh moved into the server, and the desktop now only asks the server for a fresh token when a call fails with 401.'
            }
          ]
        },
        {
          noteId: 'l2',
          by: 'owner',
          entries: [
            {
              ...item(
                9,
                'Rework the connector token refresh so paired servers renew before expiry',
                'working'
              ),
              event: 'commented',
              text: 'Ship it behind the existing setting.'
            }
          ]
        }
      ]}
    />
  )
})

let rowAt = at
const row = (
  turn: string,
  message: Omit<NativeChatMessage, 'id' | 'timestamp' | 'source'>
): [NativeChatMessage, string] => {
  rowAt += 60_000
  const id = `row-${rowAt}`
  return [{ id, timestamp: rowAt, source: 'transcript', ...message }, turn]
}
const words = (turn: string, role: 'user' | 'assistant', text: string) =>
  row(turn, { role, blocks: [{ type: 'text', text }] })
const notes = (turn: string, by: BotItemNoteView['by'], entries: BotItemNoteEntry[]) =>
  row(turn, { role: 'system', blocks: [], botItemNote: { noteId: `n-${rowAt}`, by, entries } })
const moved = (
  entry: ReturnType<typeof item>,
  from: BotItemNoteEntry['status'],
  to: BotItemNoteEntry['status']
): BotItemNoteEntry => ({ ...entry, status: to, event: 'status', from, to })
const tok = item(6, 'Connector token refresh fix', 'done')
const login = item(10, 'Login flaky test', 'planned')
const exp = item(11, 'Export timeout on large repos', 'planned')
const bulk = [
  'Sidebar badge count drift',
  'Terminal paste double newline',
  'Settings search misses aliases',
  'Remote host reconnect toast',
  'Diff viewer wraps long lines'
].map((title, index) => item(20 + index, title, 'planned'))

const transcript = [
  words('t1', 'user', 'The Windows path test is flaky again, and plan the 1.4.233 release.'),
  words('t1', 'assistant', 'Tracking both, and starting the casing audit.'),
  notes(
    't1',
    'bot',
    [rn, win, fl].map((entry) => ({ ...entry, event: 'made' as const }))
  ),
  notes('t1', 'bot', [
    moved(win, 'planned', 'working'),
    { ...win, status: 'working', event: 'linked', refs: ['dispatch:ctx_1'] }
  ]),
  notes('t1', 'owner', [moved(sd, 'working', 'done')]),
  notes('t1', 'bot', [
    { ...sl, event: 'commented', text: 'Should existing links keep edit access?' },
    moved(sl, 'working', 'needs_you')
  ]),
  words('t1', 'assistant', 'One call on share links before I go on.'),
  words('t2', 'user', 'Keep edit access. The token fix regressed, and file the two new bugs.'),
  notes('t2', 'bot', [moved(tok, 'done', 'working')]),
  notes(
    't2',
    'bot',
    [login, exp].map((entry) => ({ ...entry, event: 'made' as const }))
  ),
  notes('t2', 'bot', [moved(login, 'planned', 'working'), moved(exp, 'planned', 'working')]),
  notes(
    't2',
    'bot',
    bulk.map((entry) => ({ ...entry, event: 'made' as const }))
  ),
  notes(
    't2',
    'bot',
    bulk.map((entry) => moved(entry, 'planned', 'working'))
  ),
  words('t2', 'assistant', 'Reopened the token fix and started everything.'),
  notes('t2', { kind: 'chat', chatId: 'chat-2', title: 'Release prep' }, [
    moved(exp, 'planned', 'working')
  ]),
  notes('t2', 'owner', [
    {
      ...exp,
      status: 'working',
      event: 'commented',
      text: 'Is this the same timeout as last week?'
    }
  ])
]

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

/** Turns as the transcript draws them: folded, clustered, a row gap between slots. */
function Transcript({ rows }: { rows: [NativeChatMessage, string][] }): React.JSX.Element {
  const slots = buildNativeChatTranscriptSlots({
    messages: rows.map(([message]) => message),
    turnKeys: rows.map(([, turn]) => turn),
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: false,
    lifecycleWorking: false
  })
  return (
    <div className="flex flex-col bg-chat-pane p-4" style={{ gap: NATIVE_CHAT_ROW_GAP_PX }}>
      {slots.map((slot) => (
        <NativeChatTranscriptRow key={nativeChatSlotKey(slot)} slot={slot} context={context} />
      ))}
    </div>
  )
}

/** A bot chat's turns. */
export const turnLines = defineFixture({
  width: 680,
  render: () => <Transcript rows={transcript} />
})

const longTitle = item(
  12,
  'Bug: bot runs fail when the agent CLI is missing from PATH on first launch',
  'planned'
)
const comment = (entry: ReturnType<typeof item>, text: string): BotItemNoteEntry => ({
  ...entry,
  event: 'commented',
  text
})
const comments = [
  words('c1', 'user', 'Did the fix we merged regress anything?'),
  notes('c1', 'owner', [comment(longTitle, 'so the pr we merged has a regression?')]),
  notes('c1', 'owner', [
    comment(
      sd,
      'The dialog should open on the link tab when the item already has a link, and the copy button needs a confirmation so people know it worked.'
    )
  ]),
  notes('c1', 'owner', [comment(rn, 'Add the CSV fix.'), comment(longTitle, 'Same root cause?')])
]

/** The owner's comments, each headed by its item's chip, beside a plain message. */
export const ownerComments = defineFixture({
  width: 680,
  render: () => <Transcript rows={comments} />
})

export const ownerCommentsNarrow = defineFixture({
  width: 340,
  render: () => <Transcript rows={comments} />
})

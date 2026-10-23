import { describe, expect, it } from 'vitest'
import { agentJournalItemKey, agentJournalSubmissionKey } from './agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { nativeChatRowsInDrawOrder } from './native-chat-turn-grouping'
import { nativeChatTurnMembership, structuredAgentTurnAnchors } from './native-chat-turn-membership'
import type { NativeChatRole } from './native-chat-types'

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
let sequence = 0

function item(
  itemId: string,
  body: AgentJournalItemBody,
  /** Null for a host that predates scopes. */
  turnScope: AgentJournalTurnScope | null = THREAD
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body,
    ...(turnScope ? { turnScope } : {})
  }
}

const user = (itemId: string, scope?: AgentJournalTurnScope | null) =>
  item(itemId, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: itemId }] }, scope)
const assistant = (itemId: string, scope?: AgentJournalTurnScope | null) =>
  item(
    itemId,
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: itemId }] },
    scope
  )
const status = (itemId: string, scope?: AgentJournalTurnScope | null) =>
  item(itemId, { kind: 'status', text: itemId }, scope)
const turn = (
  itemId: string,
  userItemId: string | undefined,
  scope?: AgentJournalTurnScope | null,
  state: 'running' | 'completed' = 'completed'
) =>
  item(
    itemId,
    {
      kind: 'turn',
      turnId: itemId,
      state,
      ...(userItemId === undefined ? {} : { userItemId })
    },
    scope
  )
const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })

/** Rows as a surface hands them over: journal items that draw, in order. */
function rows(items: readonly AgentJournalRenderItem[]): { id: string; role: NativeChatRole }[] {
  return items.flatMap((entry): { id: string; role: NativeChatRole }[] => {
    if (entry.body.kind === 'message') {
      return [{ id: entry.itemId, role: entry.body.role === 'user' ? 'user' : 'assistant' }]
    }
    return entry.body.kind === 'status' ? [{ id: entry.itemId, role: 'system' }] : []
  })
}

function keys(
  items: readonly AgentJournalRenderItem[],
  submissions: readonly AgentJournalSubmission[] = []
) {
  return nativeChatTurnMembership(rows(items), { items, submissions }).turnKeys
}

function liveTurnKey(items: readonly AgentJournalRenderItem[]) {
  return nativeChatTurnMembership(rows(items), { items, submissions: [] }).liveTurnKey
}

describe('nativeChatTurnMembership', () => {
  it('groups rows by the turn their scope names, and a steer into the turn it joined', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      assistant('a1', inTurn('t1')),
      user('steer', inTurn('t1')),
      assistant('a2', inTurn('t1')),
      status('note')
    ]
    expect(keys(items)).toEqual(['u1', 'u1', 'u1', 'u1', undefined])
  })

  it('keys a turn no message opened on its own record', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      assistant('a1', inTurn('t1')),
      // A provider-resumed turn: its record names no present user entry.
      turn('wake', 'codex:thread:wake:0'),
      assistant('a2', inTurn('wake'))
    ]
    expect(keys(items)).toEqual(['u1', 'u1', 'wake'])
  })

  it('anchors a command turn on its /compact entry, and leaves the turn before it alone', () => {
    const compactKey = agentJournalSubmissionKey('cmd-1')
    const commandTurn = agentJournalItemKey({
      provider: 'orca',
      clientMessageId: 'command-turn:cmd-1'
    })
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      assistant('a1', inTurn('t1')),
      item(compactKey, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/compact' }],
        command: { name: 'compact' }
      }),
      turn(commandTurn, compactKey),
      status('compacted', inTurn(commandTurn))
    ]
    expect(keys(items)).toEqual(['u1', 'u1', compactKey, compactKey])
  })

  it('resolves a turn record naming the provider item a submission adopted', () => {
    const sent = agentJournalSubmissionKey('send-1')
    const items = [user(sent), turn('t1', 'codex:thread:t1:0'), assistant('a1', inTurn('t1'))]
    const submissions: AgentJournalSubmission[] = [
      {
        clientMessageId: 'send-1',
        fence: 1,
        payloadFingerprint: 'f',
        dispatchState: 'accepted',
        providerItemId: 'codex:thread:t1:0',
        reason: null,
        submittedAt: 1,
        resolvedAt: 2
      }
    ]
    expect(keys(items, submissions)).toEqual([sent, sent])
    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe(sent)
  })

  it('places a conversation row, and a row naming a turn the journal no longer holds, in none', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1'),
      status('restart-note'),
      assistant('orphan', inTurn('gone'))
    ]
    expect(keys(items)).toEqual(['u1', undefined, undefined])
  })

  it('groups by position for a host that states no scope, and with no journal', () => {
    const items = [user('u1', null), assistant('a1', null), user('u2', null), status('s', null)]
    expect(keys(items)).toEqual(['u1', 'u1', 'u2', 'u2'])
    expect(nativeChatTurnMembership(rows(items)).turnKeys).toEqual(['u1', 'u1', 'u2', 'u2'])
  })
})

describe('the live turn', () => {
  it('is a running turn the provider opened on its own, not the settled user turn before it', () => {
    const settled = [user('u1'), turn('t1', 'u1'), assistant('a1', inTurn('t1'))]
    const wake = turn('wake', 'codex:thread:wake:0', THREAD, 'running')
    // Just opened: nothing drawn for it yet, and still the live turn.
    expect(liveTurnKey([...settled, wake])).toBe('wake')
    expect(liveTurnKey([...settled, wake, assistant('a2', inTurn('wake'))])).toBe('wake')
  })

  it('is the user row that opened the running turn, including after a steer into it', () => {
    const items = [
      user('u1'),
      turn('t1', 'u1', THREAD, 'running'),
      assistant('a1', inTurn('t1')),
      user('steer', inTurn('t1'))
    ]
    expect(liveTurnKey(items)).toBe('u1')
  })

  const PROVIDER_KEY = 'codex:thread:t1:0'
  /** A send handed over (echoed under the turn's provider key, or not yet), or still queued. */
  const sent = (
    clientMessageId: string,
    state: 'echoed' | 'unechoed' | 'queued'
  ): AgentJournalSubmission => ({
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: state === 'echoed' ? 'accepted' : 'pending',
    providerItemId: state === 'echoed' ? PROVIDER_KEY : null,
    reason: null,
    submittedAt: 1,
    resolvedAt: state === 'echoed' ? 2 : null,
    handoverRecorded: true,
    ...(state === 'queued' ? {} : { handedOverAt: 1 })
  })
  const opener = agentJournalSubmissionKey('first')
  const second = agentJournalSubmissionKey('second')

  function expectOpenedBy(
    items: readonly AgentJournalRenderItem[],
    submissions: readonly AgentJournalSubmission[]
  ): void {
    expect(structuredAgentTurnAnchors(items, submissions).get('t1')).toBe(opener)
    const membership = nativeChatTurnMembership(rows(items), { items, submissions })
    expect(membership.liveTurnKey).toBe(opener)
    expect(membership.turnKeys[rows(items).findIndex((row) => row.id === opener)]).toBe(opener)
  }

  // Codex can echo a steer before the send that opened the turn, under the turn's one provider key.
  it('stays on the send that opened the running turn when a steer into it is echoed first', () => {
    const items = [
      user(opener),
      turn('t1', PROVIDER_KEY, THREAD, 'running'),
      user(second, inTurn('t1'))
    ]
    expectOpenedBy(items, [sent('first', 'unechoed'), sent('second', 'echoed')])
    expect(keys(items, [sent('first', 'unechoed'), sent('second', 'echoed')])).toEqual([
      opener,
      opener
    ])
  })

  // Accepted above the send's handover (queued behind /compact), and not handed over at the record.
  it('stays on the send that opened the running turn, not a message still queued above it', () => {
    const items = [user(second), user(opener), turn('t1', PROVIDER_KEY, THREAD, 'running')]
    expectOpenedBy(items, [sent('first', 'unechoed'), sent('second', 'queued')])
    expectOpenedBy(items, [sent('first', 'echoed'), sent('second', 'queued')])
  })

  // A host that hands both over before the turn opens: the echoed send, not the one still unechoed.
  it('stays on the echoed send that opened it, not a later send handed over before the record', () => {
    const items = [user(opener), user(second), turn('t1', PROVIDER_KEY, THREAD, 'running')]
    expectOpenedBy(items, [sent('first', 'echoed'), sent('second', 'unechoed')])
  })

  it('is the newest user row while its send has not opened a turn', () => {
    const items = [user('u1'), turn('t1', 'u1'), assistant('a1', inTurn('t1')), user('u2')]
    expect(liveTurnKey(items)).toBe('u2')
  })

  it('is the newest user row for a host that states no scope, and with no journal', () => {
    const items = [
      user('u1', null),
      turn('wake', undefined, null, 'running'),
      assistant('a1', null),
      user('u2', null),
      status('s', null)
    ]
    expect(liveTurnKey(items)).toBe('u2')
    expect(nativeChatTurnMembership(rows(items)).liveTurnKey).toBe('u2')
    expect(nativeChatTurnMembership([]).liveTurnKey).toBeUndefined()
  })
})

describe('a turn whose record is above the loaded rows', () => {
  const tail = () => [assistant('a300', inTurn('t1')), assistant('a301', inTurn('t1'))]
  const hostTurn = (state: 'running' | 'completed', itemId = 't1') => ({
    itemId,
    observedAt: 1,
    turn: { turnId: itemId, state, userItemId: 'u1' }
  })
  const membership = (
    items: readonly AgentJournalRenderItem[],
    latestTurn: ReturnType<typeof hostTurn>
  ) => nativeChatTurnMembership(rows(items), { items, submissions: [], latestTurn })

  it('groups its tail under the live bar while it runs, marked partial', () => {
    const live = membership(tail(), hostTurn('running'))
    expect(live.turnKeys).toEqual(['t1', 't1'])
    expect(live.liveTurnKey).toBe('t1')
    expect(live.partialTurnKey).toBe('t1')
  })

  it('leaves its tail ungrouped once it ends, whichever turn is newest', () => {
    expect(membership(tail(), hostTurn('completed')).turnKeys).toEqual([undefined, undefined])
    const next = membership([...tail(), user('u2')], hostTurn('running', 't2'))
    expect(next.turnKeys.slice(0, 2)).toEqual([undefined, undefined])
  })

  it('is whole once its record loads', () => {
    const items = [user('u1'), turn('t1', 'u1', THREAD, 'running'), ...tail()]
    const loaded = membership(items, hostTurn('running'))
    expect(loaded.turnKeys).toEqual(['u1', 'u1', 'u1'])
    expect(loaded.partialTurnKey).toBeUndefined()
  })
})

// A message sent while A runs, which the provider queued behind A: its turn opens only after A's
// remaining rows, which the journal wrote after it.
describe('a message the provider answered after the running turn', () => {
  const journal = (statesScope: boolean) => {
    const scope = (turnItemId?: string) =>
      statesScope ? (turnItemId ? inTurn(turnItemId) : THREAD) : null
    return [
      user('A', scope()),
      turn('tA', 'A', scope()),
      assistant('a1', scope('tA')),
      user('B', scope('tA')),
      assistant('a-tool', scope('tA')),
      assistant('FIRST DONE', scope('tA')),
      turn('tB', 'B', scope(), 'running'),
      assistant('b1', scope('tB'))
    ]
  }

  it.each([
    ['states each row’s turn', true],
    ['states no scope', false]
  ])("draws A's remaining rows in A's turn, then B, on a host that %s", (_host, statesScope) => {
    const items = journal(statesScope)
    const transcript = rows(items)
    const membership = nativeChatTurnMembership(transcript, { items, submissions: [] })
    const drawn = nativeChatRowsInDrawOrder(
      transcript.map((row, index) => [row.id, membership.turnKeys[index]]),
      membership.drawOrder
    )
    expect(drawn).toEqual([
      ['A', 'A'],
      ['a1', 'A'],
      ['a-tool', 'A'],
      ['FIRST DONE', 'A'],
      ['B', 'B'],
      ['b1', 'B']
    ])
    expect(membership.liveTurnKey).toBe('B')
  })

  // A message shown as not sent stays in the outbox, below every journal row.
  it.each([
    ['states each row turn', THREAD],
    ['states no turn scope', null]
  ] as const)(
    'puts a message shown as not sent in no turn, never the live one (host %s)',
    (_host, scope) => {
      const items = [user('u1', scope), turn('t1', 'u1', scope), user('u2', scope)]
      const messages = [
        ...rows(items),
        { id: 'held', role: 'user' as const, unsent: true as const }
      ]
      const membership = nativeChatTurnMembership(messages, { items, submissions: [] })
      expect(membership.turnKeys).toEqual(['u1', 'u2', undefined])
      // The send whose turn has not opened yet is live, not the message below it.
      expect(membership.liveTurnKey).toBe('u2')
    }
  )
})

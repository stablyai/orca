import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from './agent-session-journal-types'
import { foldToolMessages } from './native-chat-tool-fold'
import { nativeChatRowsInDrawOrder } from './native-chat-turn-grouping'
import { nativeChatTurnMembership } from './native-chat-turn-membership'
import type { NativeChatMessage, NativeChatRole } from './native-chat-types'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'

const THREAD: AgentJournalTurnScope = { kind: 'thread' }
const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope | null = THREAD
): AgentJournalRenderItem {
  return {
    itemId,
    sequence,
    body,
    revision: 0,
    observedAt: sequence,
    ...(turnScope ? { turnScope } : {})
  }
}

function text(
  id: string,
  sequence: number,
  role: NativeChatRole,
  scope: AgentJournalTurnScope | null = THREAD
): AgentJournalRenderItem {
  return item(id, sequence, { kind: 'message', role, blocks: [{ type: 'text', text: id }] }, scope)
}

function turn(
  id: string,
  sequence: number,
  userItemId: string,
  scope: AgentJournalTurnScope | null = THREAD,
  state: 'completed' | 'running' = 'completed'
): AgentJournalRenderItem {
  return item(id, sequence, { kind: 'turn', turnId: id, userItemId, state }, scope)
}

function mixedResult(
  id: string,
  sequence: number,
  scope: AgentJournalTurnScope | null
): AgentJournalRenderItem {
  return item(
    id,
    sequence,
    {
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: id },
        { type: 'tool-result', callId: 'unavailable-call', output: `output ${id}` }
      ]
    },
    scope
  )
}

function orphan(id: string, sequence: number, index = 0): NativeChatMessage {
  return {
    id,
    role: 'tool',
    source: 'transcript',
    timestamp: sequence,
    journalPosition: { sequence, index },
    blocks: [{ type: 'tool-result', callId: 'unavailable-call', output: id }]
  }
}

function projected(items: readonly AgentJournalRenderItem[]): NativeChatMessage[] {
  return foldToolMessages(projectStructuredItemsToNativeChat(items))
}

describe('derived tool row turn ownership', () => {
  it.each([true, false])(
    'keeps output before the prompt waiting behind its source turn (host scopes: %s)',
    (statesScopes) => {
      const scope = (id?: string) => (statesScopes ? (id ? inTurn(id) : THREAD) : null)
      const items = [
        text('A', 1, 'user', scope()),
        turn('tA', 2, 'A', scope()),
        text('a1', 3, 'assistant', scope('tA')),
        text('B', 4, 'user', scope('tA')),
        mixedResult('source', 5, scope('tA')),
        turn('tB', 6, 'B', scope(), 'running'),
        text('b1', 7, 'assistant', scope('tB'))
      ]
      const messages = projected(items)
      const output = messages.find((message) => message.role === 'tool')
      expect(output?.id).not.toBe('source')
      expect(output?.journalPosition).toEqual({ sequence: 5, index: 0 })
      const membership = nativeChatTurnMembership(messages, { items, submissions: [] })
      const drawn = nativeChatRowsInDrawOrder(
        messages.map((message, index) => [message.id, membership.turnKeys[index]]),
        membership.drawOrder
      )
      expect(drawn).toEqual([
        ['A', 'A'],
        ['a1', 'A'],
        ['source', 'A'],
        [output?.id, 'A'],
        ['B', 'B'],
        ['b1', 'B']
      ])
      expect(membership.liveTurnKey).toBe('B')
    }
  )

  it('uses an older host’s journal order when a derived output follows a newer prompt', () => {
    const items = [
      text('A', 1, 'user', null),
      turn('tA', 2, 'A', null),
      text('source', 3, 'assistant', null),
      text('B', 4, 'user', null)
    ]
    const messages = [...projectStructuredItemsToNativeChat(items), orphan('derived', 3)]
    const membership = nativeChatTurnMembership(messages, { items, submissions: [] })
    expect(membership.turnKeys).toEqual(['A', 'A', 'B', 'A'])
    expect(membership.liveTurnKey).toBe('B')
  })

  it('keeps thread-scoped output outside turns rather than inheriting the preceding turn', () => {
    const items = [
      text('A', 1, 'user'),
      turn('tA', 2, 'A', THREAD, 'running'),
      text('a1', 3, 'assistant', inTurn('tA')),
      mixedResult('source', 4, THREAD)
    ]
    const membership = nativeChatTurnMembership(projected(items), { items, submissions: [] })
    expect(membership.turnKeys).toEqual(['A', 'A', undefined, undefined])
    expect(membership.liveTurnKey).toBe('A')
  })

  it('distinguishes differently scoped items created by the same lifecycle batch', () => {
    const items = [
      text('A', 1, 'user'),
      turn('tA', 2, 'A'),
      mixedResult('owned-source', 3, inTurn('tA')),
      { ...mixedResult('thread-source', 3, THREAD), sequenceIndex: 1 }
    ]
    const membership = nativeChatTurnMembership(projected(items), { items, submissions: [] })
    expect(membership.turnKeys).toEqual(['A', 'A', 'A', undefined, undefined])
  })

  it('keeps a derived tail in the partially loaded live turn', () => {
    const items = [mixedResult('tail-source', 30, inTurn('tA'))]
    const membership = nativeChatTurnMembership(projected(items), {
      items,
      submissions: [],
      latestTurn: {
        itemId: 'tA',
        observedAt: 2,
        turn: { turnId: 'tA', userItemId: 'A', state: 'running' }
      }
    })
    expect(membership.turnKeys).toEqual(['tA', 'tA'])
    expect(membership.liveTurnKey).toBe('tA')
    expect(membership.partialTurnKey).toBe('tA')
  })

  it('prefers a row’s own journal identity over inconsistent source position metadata', () => {
    const items = [
      text('A', 1, 'user'),
      turn('tA', 2, 'A'),
      text('source', 3, 'assistant', inTurn('tA')),
      text('B', 4, 'user'),
      turn('tB', 5, 'B'),
      text('known', 6, 'assistant', inTurn('tB'))
    ]
    const membership = nativeChatTurnMembership([orphan('known', 3)], { items, submissions: [] })
    expect(membership.turnKeys).toEqual(['B'])
  })

  it('does not replace an older host’s known but unattributed item using another row’s position', () => {
    const items = [
      text('known', 1, 'assistant', null),
      text('A', 2, 'user', null),
      turn('tA', 3, 'A', null),
      text('source', 4, 'assistant', null),
      text('B', 5, 'user', null)
    ]
    const prompt = projectStructuredItemsToNativeChat([items[4]!])
    const membership = nativeChatTurnMembership([...prompt, orphan('known', 4)], {
      items,
      submissions: []
    })
    expect(membership.turnKeys).toEqual(['B', 'B'])
  })

  it('leaves unknown or ambiguous journal positions unattributed', () => {
    const items = [
      text('A', 1, 'user'),
      turn('tA', 2, 'A'),
      text('source', 3, 'assistant', inTurn('tA')),
      text('conflicting-source', 3, 'assistant', THREAD)
    ]
    const membership = nativeChatTurnMembership(
      [orphan('ambiguous', 3), orphan('unknown-sequence', 50), orphan('unknown-index', 3, 2)],
      { items, submissions: [] }
    )
    expect(membership.turnKeys).toEqual([undefined, undefined, undefined])
  })

  it('indexes source positions once for many derived rows and skips that work for known rows', () => {
    let sequenceReads = 0
    const sources = Array.from({ length: 1_024 }, (_, index) => {
      const source = text(`source-${index}`, index + 3, 'assistant', inTurn('tA'))
      return {
        ...source,
        get sequence() {
          sequenceReads += 1
          return source.sequence
        }
      }
    })
    const items = [text('A', 1, 'user'), turn('tA', 2, 'A'), ...sources]
    const journal = { items, submissions: [], latestTurn: null }
    const derived = sources.map((source, index) => orphan(`derived-${source.itemId}`, index + 3))
    const membership = nativeChatTurnMembership(derived, journal)
    expect(membership.turnKeys).toEqual(sources.map(() => 'A'))
    expect(sequenceReads).toBe(sources.length)

    sequenceReads = 0
    const known = sources.map((source, index) => orphan(source.itemId, index + 3))
    expect(nativeChatTurnMembership(known, journal).turnKeys).toEqual(sources.map(() => 'A'))
    expect(sequenceReads).toBe(0)
  })

  it('ignores terminal transcript offsets and preserves positional grouping without a journal', () => {
    const items = [
      text('A', 1, 'user'),
      turn('tA', 2, 'A'),
      text('source', 3, 'assistant', inTurn('tA')),
      text('B', 4, 'user')
    ]
    const source = orphan('offset-only', 3)
    const { journalPosition: _position, ...withoutPosition } = source
    const messages = [
      ...projectStructuredItemsToNativeChat(items),
      { ...withoutPosition, transcriptOffset: 3 },
      orphan('positioned', 3)
    ]
    expect(nativeChatTurnMembership(messages).turnKeys).toEqual(['A', 'A', 'B', 'B', 'B'])
    expect(nativeChatTurnMembership(messages).drawOrder).toBeNull()
    expect(nativeChatTurnMembership(messages, { items, submissions: [] }).turnKeys).toEqual([
      'A',
      'A',
      'B',
      undefined,
      'A'
    ])
  })
})

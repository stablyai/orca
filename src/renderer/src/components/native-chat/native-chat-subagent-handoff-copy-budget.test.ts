import { describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { nativeChatSubagentSections } from './native-chat-subagent-sections'
import { nativeChatSubagentLiveSections } from './native-chat-subagent-live-frontier'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'

function message(
  id: string,
  blocks: NativeChatMessage['blocks'],
  sequence: number,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks,
    timestamp: 1,
    source: 'transcript',
    journalPosition: { sequence, index: 0 },
    ...extra
  }
}

function handoff(index: number, agents = ['child']): NativeChatMessage {
  return message(
    `handoff-${index}`,
    [
      {
        type: 'tool-call',
        name: 'wait_agent',
        input: {
          agents,
          future: { reason: 'observe', unicode: '🙂' },
          optional: undefined
        }
      }
    ],
    index + 10
  )
}

function fixture(calls: readonly NativeChatMessage[]) {
  const roster = message(
    'root-roster',
    [
      {
        type: 'subagent-group',
        groupId: 'root',
        agents: [{ id: 'parent', label: 'parent', state: 'working' }]
      }
    ],
    1,
    { role: 'system' }
  )
  const parent = message('parent-row', [{ type: 'text', text: 'delegating' }], 2, {
    agentId: 'parent',
    producerKind: 'agent'
  })
  const child = message('child-row', [{ type: 'text', text: 'reading' }], 3, {
    agentId: 'child',
    parentAgentId: 'parent',
    producerKind: 'agent'
  })
  const conversation = [roster, ...calls]
  const sections = nativeChatSubagentSections(
    conversation,
    new Map([
      ['parent', [{ message: parent, turnKey: undefined }]],
      ['child', [{ message: child, turnKey: undefined }]]
    ])
  )
  return { conversation, sections, roster, parent, child }
}

function slots(input: ReturnType<typeof fixture>) {
  return buildNativeChatTranscriptSlots({
    messages: input.conversation,
    turnKeys: input.conversation.map(() => undefined),
    liveTurnKey: undefined,
    receipts: new Map(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map(),
    expandedTurnKeys: new Set(),
    isWorking: true,
    lifecycleWorking: false,
    subagentSections: input.sections
  })
}

function countHandoffCopies(
  input: ReturnType<typeof fixture>,
  calls: readonly NativeChatMessage[]
) {
  const tracked = new Set<unknown>(calls)
  const set = Map.prototype.set
  const values = Array.prototype[Symbol.iterator]
  let copies = 0
  const spy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key,
    value
  ) {
    if (key === 'parent' && Array.isArray(value) && tracked.has(value[0])) {
      Object.defineProperty(value, Symbol.iterator, {
        configurable: true,
        value: () => {
          const iterator = values.call(value)
          const next = iterator.next.bind(iterator)
          iterator.next = (...args) => {
            const item = next(...args)
            if (!item.done) {
              copies += 1
            }
            return item
          }
          return iterator
        }
      })
    }
    return set.call(this, key, value)
  })
  try {
    const live = nativeChatSubagentLiveSections(input.conversation, input.sections, true)
    spy.mockRestore()
    return { live, copies }
  } finally {
    spy.mockRestore()
  }
}

describe('nested subagent handoff accumulation', () => {
  it.each([12, 128, 1000])('copies %s handoffs only for their existing final merge', (count) => {
    const calls = Array.from({ length: count }, (_, index) => handoff(index))
    const input = fixture(calls)
    const before = structuredClone(input)
    const result = countHandoffCopies(input, calls)
    expect([...result.live]).toEqual(['parent', 'child'])
    expect(input).toEqual(before)
    const messages = slots(input).flatMap((slot) => (slot.kind === 'message' ? [slot.message] : []))
    const expected = [input.roster, input.parent, input.child, ...calls]
    expect(messages).toEqual(expected)
    for (const [index, row] of messages.entries()) {
      expect(row).toBe(expected[index])
    }
    expect(result.copies).toBe(count)
  })

  it('retains duplicate records, colliding message IDs and unknown input fields without mutating inputs', () => {
    const first = handoff(0)
    const second = handoff(1)
    second.id = first.id
    const calls = [first, first, second]
    const input = fixture(calls)
    const before = structuredClone(input)
    Object.freeze(input.conversation)
    for (const row of input.conversation) {
      Object.freeze(row.blocks)
      Object.freeze(row)
    }
    const result = countHandoffCopies(input, calls)
    expect([...result.live]).toEqual(['parent', 'child'])
    expect(input).toEqual(before)
    expect(result.copies).toBe(3)
  })

  it.each([{ agents: [] }, { agents: [''] }, { agents: ['unknown'] }])(
    'keeps unknown or empty target behavior for %j',
    ({ agents }) => {
      const input = fixture([handoff(0), handoff(1, agents)])
      const before = structuredClone(input)
      expect([...nativeChatSubagentLiveSections(input.conversation, input.sections, true)]).toEqual(
        ['child']
      )
      expect(input).toEqual(before)
    }
  )

  it('keeps live ordering for interleaved handoffs to different nested scopes', () => {
    const input = fixture([handoff(0), handoff(1, ['other-child']), handoff(2)])
    const group = input.roster.blocks[0]
    if (group?.type !== 'subagent-group') {
      throw new Error('Missing root roster')
    }
    group.agents.push({ id: 'other-parent', label: 'other parent', state: 'working' })
    const otherParent = message('other-parent-row', [{ type: 'text', text: 'delegating' }], 4, {
      agentId: 'other-parent',
      producerKind: 'agent'
    })
    const otherChild = message('other-child-row', [{ type: 'text', text: 'reading' }], 5, {
      agentId: 'other-child',
      parentAgentId: 'other-parent',
      producerKind: 'agent'
    })
    const sections = nativeChatSubagentSections(
      input.conversation,
      new Map([
        ['parent', [{ message: input.parent, turnKey: undefined }]],
        ['child', [{ message: input.child, turnKey: undefined }]],
        ['other-parent', [{ message: otherParent, turnKey: undefined }]],
        ['other-child', [{ message: otherChild, turnKey: undefined }]]
      ])
    )
    const before = structuredClone({ input, sections })
    expect([...nativeChatSubagentLiveSections(input.conversation, sections, true)]).toEqual([
      'other-parent',
      'child',
      'other-child'
    ])
    expect({ input, sections }).toEqual(before)
  })

  it('derives fresh results on interleaved sessions with identical IDs and no carried handoffs', () => {
    const waiting = fixture([handoff(0)])
    const plain = fixture([])
    expect([
      ...nativeChatSubagentLiveSections(waiting.conversation, waiting.sections, true)
    ]).toEqual(['parent', 'child'])
    expect([...nativeChatSubagentLiveSections(plain.conversation, plain.sections, true)]).toEqual([
      'parent'
    ])
    expect([
      ...nativeChatSubagentLiveSections(waiting.conversation, waiting.sections, true)
    ]).toEqual(['parent', 'child'])
    expect(nativeChatSubagentLiveSections(waiting.conversation, waiting.sections, false)).toBe(
      nativeChatSubagentLiveSections(plain.conversation, plain.sections, false)
    )
  })
})

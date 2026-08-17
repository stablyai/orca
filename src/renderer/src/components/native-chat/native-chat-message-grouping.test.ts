import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  buildNativeChatConversationItems,
  buildNativeChatRenderItems,
  orderNativeChatMessages
} from './native-chat-message-grouping'
import { NATIVE_CHAT_STREAMING_ID } from '../../../../shared/native-chat-streaming'

function msg(
  overrides: Partial<NativeChatMessage> & Pick<NativeChatMessage, 'id'>
): NativeChatMessage {
  return {
    role: 'assistant',
    blocks: [],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

describe('orderNativeChatMessages', () => {
  it('orders by ascending timestamp, null first', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'b', timestamp: 20 }),
      msg({ id: 'a', timestamp: 10 }),
      msg({ id: 'n', timestamp: null })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['n', 'a', 'b'])
  })

  it('breaks timestamp ties by id deterministically', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'z', timestamp: 5 }),
      msg({ id: 'a', timestamp: 5 })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['a', 'z'])
  })

  it('sorts the streaming preview after real content but before optimistic echoes', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'pending:abc', role: 'user', timestamp: 20, source: 'scrape' }),
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'real-user', role: 'user', timestamp: 10 })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['real-user', 'streaming', 'pending:abc'])
  })
})

describe('buildNativeChatRenderItems', () => {
  it('renders messages in order', () => {
    const items = buildNativeChatRenderItems([
      msg({ id: 'u', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'hi' }] }),
      msg({ id: 'a', role: 'assistant', timestamp: 2, blocks: [{ type: 'text', text: 'hello' }] })
    ])
    expect(items.map((i) => i.id)).toEqual(['u', 'a'])
    expect(items[0]?.kind).toBe('message')
  })

  it('pairs a tool-call with its tool-result into one step', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'a',
        role: 'assistant',
        timestamp: 1,
        blocks: [{ type: 'tool-call', name: 'Bash', input: { cmd: 'ls' } }]
      }),
      msg({
        id: 't',
        role: 'tool',
        timestamp: 2,
        blocks: [{ type: 'tool-result', output: 'file.txt' }]
      })
    ])
    const steps = items.filter((i) => i.kind === 'tool-step')
    expect(steps).toHaveLength(1)
    const step = steps[0]
    if (step?.kind !== 'tool-step') {
      throw new Error('expected tool-step')
    }
    expect(step.step.call.name).toBe('Bash')
    expect(step.step.result?.output).toBe('file.txt')
  })

  it('pairs parallel tool results by provider id', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'calls',
        timestamp: 1,
        blocks: [
          { type: 'tool-call', toolCallId: 'one', name: 'One', input: {} },
          { type: 'tool-call', toolCallId: 'two', name: 'Two', input: {} }
        ]
      }),
      msg({
        id: 'results',
        role: 'tool',
        timestamp: 2,
        blocks: [
          { type: 'tool-result', toolCallId: 'two', output: 'second' },
          { type: 'tool-result', toolCallId: 'one', output: 'first' }
        ]
      })
    ]).filter((item) => item.kind === 'tool-step')

    expect(items.map((item) => item.step.result?.output)).toEqual(['first', 'second'])
  })

  it('does not attach a legacy result to an unmatched provider call', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'calls',
        timestamp: 1,
        blocks: [
          { type: 'tool-call', toolCallId: 'missing', name: 'Exact', input: {} },
          { type: 'tool-call', name: 'Legacy', input: {} }
        ]
      }),
      msg({
        id: 'result',
        role: 'tool',
        timestamp: 2,
        blocks: [{ type: 'tool-result', output: 'legacy' }]
      })
    ]).filter((item) => item.kind === 'tool-step')

    expect(items.map((item) => item.step.result?.output ?? null)).toEqual([null, 'legacy'])
  })

  it('leaves an unanswered tool-call in flight (result null)', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'a',
        role: 'assistant',
        timestamp: 1,
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      })
    ])
    const step = items.find((i) => i.kind === 'tool-step')
    if (step?.kind !== 'tool-step') {
      throw new Error('expected tool-step')
    }
    expect(step.step.result).toBeNull()
  })

  it('separates prose blocks from tool blocks in the same message', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'a',
        role: 'assistant',
        timestamp: 1,
        blocks: [
          { type: 'text', text: 'running it' },
          { type: 'tool-call', name: 'Bash', input: {} }
        ]
      })
    ])
    expect(items.map((i) => i.kind)).toEqual(['message', 'tool-step'])
    const message = items[0]
    if (message?.kind !== 'message') {
      throw new Error('expected message')
    }
    expect(message.blocks).toEqual([{ type: 'text', text: 'running it' }])
  })
})

describe('buildNativeChatConversationItems', () => {
  it('keeps an explicit final in activity until terminal completion', () => {
    const turn = buildNativeChatConversationItems(
      [
        msg({ id: 'u', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'go' }] }),
        msg({
          id: 'commentary',
          timestamp: 2,
          source: 'stream',
          assistantPhase: 'commentary',
          blocks: [{ type: 'text', text: 'Checking' }]
        }),
        msg({
          id: 'final',
          timestamp: 5,
          source: 'stream',
          assistantPhase: 'final',
          blocks: [{ type: 'text', text: 'Partial final' }]
        })
      ],
      true,
      1
    )[1]

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      working: true,
      completedAt: null,
      finalMessage: null,
      activityMessages: [{ id: 'commentary' }, { id: 'final' }]
    })
  })

  it('keeps reasoning and tools chronological before the final answer', () => {
    const items = buildNativeChatConversationItems(
      [
        msg({ id: 'u', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'do it' }] }),
        msg({
          id: 'r',
          role: 'reasoning',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'checking' }]
        }),
        msg({
          id: 'call',
          timestamp: 3,
          blocks: [{ type: 'tool-call', name: 'Bash', input: { cmd: 'pwd' } }]
        }),
        msg({
          id: 'result',
          role: 'tool',
          timestamp: 4,
          blocks: [{ type: 'tool-result', output: '/repo' }]
        }),
        msg({ id: 'final', timestamp: 5, blocks: [{ type: 'text', text: 'Done.' }] })
      ],
      false
    )

    expect(items).toHaveLength(2)
    const turn = items[1]
    expect(turn?.kind).toBe('assistant-turn')
    if (turn?.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn')
    }
    expect(turn.activityMessages.map((message) => message.id)).toEqual(['r', 'call', 'result'])
    expect(turn.finalMessage?.id).toBe('final')
    expect(turn.startedAt).toBe(1)
    expect(turn.completedAt).toBe(5)
  })

  it('keeps an unclassified live stream in activity until completion', () => {
    const items = buildNativeChatConversationItems(
      [
        msg({ id: 'u', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'go' }] }),
        msg({
          id: 'r',
          role: 'reasoning',
          timestamp: 2,
          blocks: [{ type: 'text', text: 'working' }]
        }),
        msg({
          id: NATIVE_CHAT_STREAMING_ID,
          timestamp: null,
          blocks: [{ type: 'text', text: 'partial answer' }]
        })
      ],
      true,
      10
    )
    const turn = items[1]
    if (turn?.kind !== 'assistant-turn') {
      throw new Error('expected assistant turn')
    }
    expect(turn.working).toBe(true)
    expect(turn.startedAt).toBe(10)
    expect(turn.activityMessages.map((message) => message.id)).toEqual([
      'r',
      NATIVE_CHAT_STREAMING_ID
    ])
    expect(turn.finalMessage).toBeNull()
  })

  it('does not guess that an unclassified provider stream is final while working', () => {
    const turn = buildNativeChatConversationItems(
      [
        msg({ id: 'u', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'go' }] }),
        msg({
          id: 'provider-message',
          timestamp: 2,
          source: 'stream',
          blocks: [{ type: 'text', text: 'partial' }]
        })
      ],
      true,
      10
    )[1]

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      finalMessage: null,
      activityMessages: [{ id: 'provider-message' }]
    })
  })

  it('creates a new live turn after a fresh user message instead of reopening the prior turn', () => {
    const items = buildNativeChatConversationItems(
      [
        msg({ id: 'u1', role: 'user', timestamp: 1, blocks: [{ type: 'text', text: 'one' }] }),
        msg({ id: 'a1', timestamp: 2, blocks: [{ type: 'text', text: 'done' }] }),
        msg({ id: 'u2', role: 'user', timestamp: 3, blocks: [{ type: 'text', text: 'two' }] })
      ],
      true,
      4
    )

    expect(items).toHaveLength(4)
    expect(items[1]).toMatchObject({ kind: 'assistant-turn', working: false })
    expect(items[3]).toMatchObject({
      kind: 'assistant-turn',
      id: 'assistant-turn:u2',
      working: true,
      startedAt: 4,
      activityMessages: [],
      finalMessage: null
    })
  })

  it('keeps an active steer in the same turn without completing the preceding activity', () => {
    const items = buildNativeChatConversationItems(
      [
        msg({
          id: 'u1',
          role: 'user',
          turnId: 'turn-1',
          timestamp: 1,
          blocks: [{ type: 'text', text: 'start' }]
        }),
        msg({
          id: 'tool',
          turnId: 'turn-1',
          timestamp: 2,
          blocks: [
            { type: 'tool-call', toolCallId: 'call-1', name: 'Bash', input: { cmd: 'sleep 10' } }
          ]
        }),
        msg({
          id: 'steer',
          role: 'user',
          turnId: 'turn-1',
          timestamp: 3,
          blocks: [{ type: 'text', text: 'change direction' }]
        }),
        msg({
          id: 'result',
          role: 'tool',
          turnId: 'turn-1',
          timestamp: 4,
          blocks: [{ type: 'tool-result', toolCallId: 'call-1', output: 'done' }]
        })
      ],
      true,
      1,
      'turn-1'
    )

    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({
      kind: 'assistant-turn',
      turnId: 'turn-1',
      completedAt: null,
      working: true,
      activityMessages: [{ id: 'tool' }, { id: 'result' }],
      segments: [
        { kind: 'activity', messages: [{ id: 'tool' }] },
        { kind: 'message', message: { id: 'steer' } },
        { kind: 'activity', messages: [{ id: 'result' }] }
      ]
    })
  })

  it('shows completion only after the matching turn.completed event', () => {
    const messages = [
      msg({
        id: 'u',
        role: 'user',
        turnId: 'turn-1',
        timestamp: 1,
        blocks: [{ type: 'text', text: 'go' }]
      }),
      msg({
        id: 'a',
        turnId: 'turn-1',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'done' }]
      })
    ]

    expect(buildNativeChatConversationItems(messages, false, null, null, {})[1]).toMatchObject({
      kind: 'assistant-turn',
      completedAt: null
    })
    expect(
      buildNativeChatConversationItems(messages, false, null, null, {
        'turn-1': { outcome: 'completed', completedAt: 3 }
      })[1]
    ).toMatchObject({ kind: 'assistant-turn', completedAt: 3 })
  })

  it('does not promote an answer from before the last steer', () => {
    const turn = buildNativeChatConversationItems(
      [
        msg({ id: 'u', role: 'user', turnId: 'turn-1', timestamp: 1 }),
        msg({
          id: 'early-final',
          turnId: 'turn-1',
          timestamp: 2,
          assistantPhase: 'final',
          blocks: [{ type: 'text', text: 'Before steer' }]
        }),
        msg({ id: 'steer', role: 'user', turnId: 'turn-1', timestamp: 3 }),
        msg({
          id: 'commentary',
          turnId: 'turn-1',
          timestamp: 4,
          assistantPhase: 'commentary',
          blocks: [{ type: 'text', text: 'After steer' }]
        })
      ],
      false,
      null,
      null,
      { 'turn-1': { outcome: 'completed', completedAt: 5 } }
    )[1]

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      finalMessage: null,
      outcome: 'completed'
    })
  })

  it('does not promote an explicit final after interruption', () => {
    const turn = buildNativeChatConversationItems(
      [
        msg({ id: 'u', role: 'user', turnId: 'turn-1', timestamp: 1 }),
        msg({
          id: 'partial',
          turnId: 'turn-1',
          timestamp: 2,
          assistantPhase: 'final',
          blocks: [{ type: 'text', text: 'Partial' }]
        })
      ],
      false,
      null,
      null,
      { 'turn-1': { outcome: 'interrupted', completedAt: 3 } }
    )[1]

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      finalMessage: null,
      completedAt: null,
      outcome: 'interrupted'
    })
  })

  it('preserves receive order when timestamps tie', () => {
    const turn = buildNativeChatConversationItems(
      [
        msg({ id: 'u', role: 'user', timestamp: 1 }),
        msg({
          id: 'z',
          timestamp: 2,
          assistantPhase: 'commentary',
          blocks: [{ type: 'text', text: 'first' }]
        }),
        msg({
          id: 'a',
          timestamp: 2,
          assistantPhase: 'commentary',
          blocks: [{ type: 'text', text: 'second' }]
        }),
        msg({
          id: 'final',
          timestamp: 3,
          assistantPhase: 'final',
          blocks: [{ type: 'text', text: 'done' }]
        })
      ],
      false
    )[1]

    expect(turn).toMatchObject({
      kind: 'assistant-turn',
      activityMessages: [{ id: 'z' }, { id: 'a' }],
      finalMessage: { id: 'final' }
    })
  })
})

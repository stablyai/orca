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

  it('keeps a live streaming preview separate from current activity', () => {
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
    expect(turn.activityMessages.map((message) => message.id)).toEqual(['r'])
    expect(turn.finalMessage?.id).toBe(NATIVE_CHAT_STREAMING_ID)
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
})

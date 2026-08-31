import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { buildNativeChatRenderItems, orderNativeChatMessages } from './native-chat-message-grouping'
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

  it('keeps a queued prompt after its transcript predecessor despite its older timestamp', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'z-predecessor', timestamp: 10 }),
      msg({ id: 'a-queued', role: 'user', timestamp: 5, queued: true }),
      msg({ id: 'final', timestamp: 20 })
    ])
    expect(ordered.map((message) => message.id)).toEqual(['z-predecessor', 'a-queued', 'final'])
  })

  it('keeps the legacy null-first rule outside queued ordering groups', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'finite', timestamp: 10 }),
      msg({ id: 'ordinary-null', timestamp: null }),
      msg({ id: 'queued-null', role: 'user', timestamp: null, queued: true })
    ])
    expect(ordered.map((message) => message.id)).toEqual(['ordinary-null', 'finite', 'queued-null'])
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

  it('renders the queued-prompt fixture in transcript order', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'z-predecessor',
        timestamp: 10,
        blocks: [{ type: 'text', text: 'first reply' }]
      }),
      msg({
        id: 'a-queued',
        role: 'user',
        timestamp: 5,
        queued: true,
        blocks: [{ type: 'text', text: 'queued prompt' }]
      })
    ])
    expect(items.map((item) => item.id)).toEqual(['z-predecessor', 'a-queued'])
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

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

  // The reply currently streaming is the answer to the prompt the user just sent,
  // so it has to render BELOW that prompt's echo. Ranking the echo last put the
  // reply above it: the sent message looked stuck at the bottom of the transcript
  // and the user had to scroll up to read the response.
  it('sorts the streaming preview after real content and after an idle send echo', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'pending:abc', role: 'user', timestamp: 20, source: 'scrape' }),
      msg({ id: 'real-user', role: 'user', timestamp: 10 })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['real-user', 'pending:abc', 'streaming'])
  })

  it('keeps an echo queued mid-reply below the streaming preview', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'pending-queued:abc', role: 'user', timestamp: 20, source: 'scrape' }),
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'real-user', role: 'user', timestamp: 10 })
    ])
    expect(ordered.map((m) => m.id)).toEqual(['real-user', 'streaming', 'pending-queued:abc'])
  })

  it('orders an idle echo, the reply to it, then a prompt queued during that reply', () => {
    const ordered = orderNativeChatMessages([
      msg({ id: 'pending-queued:second', role: 'user', timestamp: 30, source: 'scrape' }),
      msg({ id: NATIVE_CHAT_STREAMING_ID, timestamp: null }),
      msg({ id: 'pending:first', role: 'user', timestamp: 20, source: 'scrape' })
    ])
    expect(ordered.map((m) => m.id)).toEqual([
      'pending:first',
      'streaming',
      'pending-queued:second'
    ])
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

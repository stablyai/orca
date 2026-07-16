import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  buildNativeChatRenderItems,
  orderNativeChatMessages,
  pairNativeChatToolBlocks
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
    expect(step.step.call?.name).toBe('Bash')
    expect(step.step.result?.output).toBe('file.txt')
  })

  it('pairs identified results to their calls when results arrive out of order', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'calls',
        timestamp: 1,
        blocks: [
          { type: 'tool-call', name: 'Read', input: { path: 'a' }, callId: 'call-a' },
          { type: 'tool-call', name: 'Read', input: { path: 'b' }, callId: 'call-b' }
        ]
      }),
      msg({
        id: 'results',
        role: 'tool',
        timestamp: 2,
        blocks: [
          { type: 'tool-result', output: 'contents-b', callId: 'call-b' },
          { type: 'tool-result', output: 'contents-a', callId: 'call-a' }
        ]
      })
    ])
    const steps = items.filter((item) => item.kind === 'tool-step')

    expect(steps.map((step) => step.step.result?.output)).toEqual(['contents-a', 'contents-b'])
  })

  it('preserves a result-only step when no call can consume it', () => {
    const items = buildNativeChatRenderItems([
      msg({
        id: 'call',
        timestamp: 1,
        blocks: [{ type: 'tool-call', name: 'Read', input: {}, callId: 'call-a' }]
      }),
      msg({
        id: 'result',
        role: 'tool',
        timestamp: 2,
        blocks: [{ type: 'tool-result', output: 'other output', callId: 'call-b' }]
      })
    ])
    const steps = items.filter((item) => item.kind === 'tool-step')

    expect(steps).toHaveLength(2)
    expect(steps[0]?.step).toMatchObject({ call: { callId: 'call-a' }, result: null })
    expect(steps[1]?.step).toMatchObject({ call: null, result: { callId: 'call-b' } })
    expect(steps.map((step) => step.id)).toEqual(['call:tool:0', 'result:tool:0'])
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

describe('pairNativeChatToolBlocks', () => {
  it('reserves exact matches before applying the FIFO fallback', () => {
    const steps = pairNativeChatToolBlocks([
      { type: 'tool-call', name: 'Legacy', input: {} },
      { type: 'tool-call', name: 'Read', input: {}, callId: 'identified' },
      { type: 'tool-result', output: 'identified output', callId: 'identified' },
      { type: 'tool-result', output: 'legacy output' }
    ])

    expect(steps.map((step) => step.result?.output)).toEqual(['legacy output', 'identified output'])
  })

  it('never pairs a call with a differently identified result', () => {
    const steps = pairNativeChatToolBlocks([
      { type: 'tool-call', name: 'Read', input: {}, callId: 'call-a' },
      { type: 'tool-result', output: 'output-b', callId: 'call-b' }
    ])

    expect(steps).toEqual([
      {
        operationKey: 'provider:call-a:0',
        call: { type: 'tool-call', name: 'Read', input: {}, callId: 'call-a' },
        result: null
      },
      {
        operationKey: 'provider:call-b:0',
        call: null,
        result: { type: 'tool-result', output: 'output-b', callId: 'call-b' }
      }
    ])
  })

  it('pairs duplicate ids in document order', () => {
    const steps = pairNativeChatToolBlocks([
      { type: 'tool-call', name: 'Read first', input: {}, callId: 'duplicate' },
      { type: 'tool-call', name: 'Read second', input: {}, callId: 'duplicate' },
      { type: 'tool-result', output: 'first output', callId: 'duplicate' },
      { type: 'tool-result', output: 'second output', callId: 'duplicate' }
    ])

    expect(steps.map((step) => step.result?.output)).toEqual(['first output', 'second output'])
  })

  it('allows FIFO only when at least one side is unidentified', () => {
    const steps = pairNativeChatToolBlocks([
      { type: 'tool-call', name: 'Identified', input: {}, callId: 'missing' },
      { type: 'tool-call', name: 'Unidentified', input: {} },
      { type: 'tool-result', output: 'identified elsewhere', callId: 'other' },
      { type: 'tool-result', output: 'unidentified output' }
    ])

    expect(steps.map((step) => step.result?.output)).toEqual([
      'unidentified output',
      'identified elsewhere'
    ])
  })

  it('pairs an identified result that appears before its call', () => {
    const steps = pairNativeChatToolBlocks([
      { type: 'tool-result', output: 'early output', callId: 'call-1' },
      { type: 'tool-call', name: 'Read', input: {}, callId: 'call-1' }
    ])

    expect(steps).toEqual([
      {
        operationKey: 'provider:call-1:0',
        call: { type: 'tool-call', name: 'Read', input: {}, callId: 'call-1' },
        result: { type: 'tool-result', output: 'early output', callId: 'call-1' }
      }
    ])
  })

  it('treats blank ids as unavailable for FIFO compatibility', () => {
    const steps = pairNativeChatToolBlocks([
      { type: 'tool-call', name: 'Legacy', input: {}, callId: '   ' },
      { type: 'tool-result', output: 'output', callId: 'call-1' }
    ])

    expect(steps).toHaveLength(1)
    expect(steps[0]?.result?.output).toBe('output')
  })

  it('keeps call identity stable when its result is appended', () => {
    const call = { type: 'tool-call', name: 'Read', input: {}, callId: 'call-1' } as const
    const result = { type: 'tool-result', output: 'contents', callId: 'call-1' } as const

    const before = pairNativeChatToolBlocks([call])
    const after = pairNativeChatToolBlocks([call, result])

    expect(before[0]?.operationKey).toBe('provider:call-1:0')
    expect(after[0]?.operationKey).toBe(before[0]?.operationKey)
  })

  it('keeps identified result identity stable when its call arrives later', () => {
    const result = { type: 'tool-result', output: 'contents', callId: 'call-1' } as const
    const call = { type: 'tool-call', name: 'Read', input: {}, callId: 'call-1' } as const

    const before = pairNativeChatToolBlocks([result])
    const after = pairNativeChatToolBlocks([result, call])

    expect(before[0]?.operationKey).toBe('provider:call-1:0')
    expect(after[0]?.operationKey).toBe(before[0]?.operationKey)
  })

  it('disambiguates duplicate provider ids deterministically', () => {
    const steps = pairNativeChatToolBlocks([
      { type: 'tool-call', name: 'First', input: {}, callId: 'duplicate' },
      { type: 'tool-call', name: 'Second', input: {}, callId: 'duplicate' }
    ])

    expect(steps.map((step) => step.operationKey)).toEqual([
      'provider:duplicate:0',
      'provider:duplicate:1'
    ])
  })
})

import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { stripNoiseMessages } from './native-chat-noise'
import { foldToolMessages, splitNativeChatBlocks } from './native-chat-tool-fold'

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

describe('foldToolMessages', () => {
  it('merges a tool-only message into the preceding assistant turn', () => {
    const folded = foldToolMessages([
      msg({
        id: 'a',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'running it' },
          { type: 'tool-call', name: 'Bash', input: {} }
        ]
      }),
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'done' }] })
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0]?.id).toBe('a')
    expect(folded[0]?.blocks).toEqual([
      { type: 'text', text: 'running it' },
      { type: 'tool-call', name: 'Bash', input: {} },
      { type: 'tool-result', output: 'done' }
    ])
  })

  it('merges a chain of tool-only assistant + tool messages into one turn', () => {
    const folded = foldToolMessages([
      msg({ id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'go' }] }),
      msg({ id: 'c', role: 'assistant', blocks: [{ type: 'tool-call', name: 'Bash', input: {} }] }),
      msg({ id: 'r', role: 'tool', blocks: [{ type: 'tool-result', output: 'ok' }] })
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0]?.blocks).toHaveLength(3)
  })

  it('drops a tool result no loaded call can own instead of leaving it standalone', () => {
    const folded = foldToolMessages([
      msg({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'x' }] })
    ])
    expect(folded.map((m) => m.id)).toEqual(['u'])
  })

  it('drops a result after a user turn abandons the pending call', () => {
    const folded = foldToolMessages([
      msg({ id: 'c', role: 'assistant', blocks: [{ type: 'tool-call', name: 'Bash', input: {} }] }),
      msg({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'stop' }] }),
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'x' }] })
    ])
    expect(folded.map((m) => m.id)).toEqual(['c', 'u'])
  })

  it('keeps a hidden interruption as an attribution boundary', () => {
    const folded = stripNoiseMessages(
      foldToolMessages([
        msg({
          id: 'c',
          role: 'assistant',
          blocks: [{ type: 'tool-call', name: 'Bash', input: {} }]
        }),
        msg({
          id: 'i',
          role: 'user',
          blocks: [{ type: 'text', text: '[Request interrupted by user]' }]
        }),
        msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'stale' }] })
      ])
    )

    expect(folded.map((message) => message.id)).toEqual(['c'])
    expect(folded[0]?.blocks).toEqual([{ type: 'tool-call', name: 'Bash', input: {} }])
  })

  it('removes a result folded into assistant prose without mutating the source', () => {
    const assistant = msg({
      id: 'a',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'continuing' }]
    })

    const folded = foldToolMessages([
      assistant,
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'stale' }] })
    ])

    expect(folded).toEqual([assistant])
    expect(folded[0]).not.toBe(assistant)
  })

  it('does not fold a message carrying prose alongside a tool block', () => {
    const folded = foldToolMessages([
      msg({ id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'first' }] }),
      msg({
        id: 'b',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'more' },
          { type: 'tool-call', name: 'Read', input: {} }
        ]
      })
    ])
    expect(folded.map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('attributes a Claude tool result carried with a harness sidecar', () => {
    const folded = foldToolMessages([
      msg({
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      }),
      msg({
        id: 'u',
        role: 'user',
        blocks: [
          { type: 'tool-result', output: 'important output' },
          { type: 'text', text: '<system-reminder>continue</system-reminder>' }
        ]
      })
    ])

    expect(folded).toEqual([
      expect.objectContaining({
        id: 'a',
        blocks: [
          { type: 'tool-call', name: 'Read', input: {} },
          { type: 'tool-result', output: 'important output' }
        ]
      }),
      expect.objectContaining({
        id: 'u',
        blocks: [{ type: 'text', text: '<system-reminder>continue</system-reminder>' }]
      })
    ])
  })

  it('does not traverse an interruption sidecar carrying a stale result', () => {
    const folded = foldToolMessages([
      msg({
        id: 'a',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      }),
      msg({
        id: 'i',
        role: 'user',
        blocks: [
          { type: 'tool-result', output: 'stale' },
          { type: 'text', text: '[Request interrupted by user]' }
        ]
      })
    ])

    expect(folded).toEqual([
      expect.objectContaining({
        id: 'a',
        blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
      }),
      expect.objectContaining({
        id: 'i',
        blocks: [{ type: 'text', text: '[Request interrupted by user]' }]
      })
    ])
  })

  it('folds through a harness noise boundary but not a real user turn', () => {
    const folded = foldToolMessages([
      msg({ id: 'a', role: 'assistant', blocks: [{ type: 'tool-call', name: 'Read', input: {} }] }),
      msg({ id: 'n', role: 'user', blocks: [{ type: 'text', text: '<task-notification>done' }] }),
      msg({ id: 'r', role: 'tool', blocks: [{ type: 'tool-result', output: 'ok' }] })
    ])

    expect(folded.find((message) => message.id === 'a')?.blocks).toEqual([
      { type: 'tool-call', name: 'Read', input: {} },
      { type: 'tool-result', output: 'ok' }
    ])
  })
})

describe('splitNativeChatBlocks', () => {
  it('separates prose from tool blocks', () => {
    const { prose, tools } = splitNativeChatBlocks([
      { type: 'text', text: 'hi' },
      { type: 'tool-call', name: 'Bash', input: {} },
      { type: 'tool-result', output: 'ok' },
      { type: 'image-ref', path: '/x.png' }
    ])
    expect(prose.map((b) => b.type)).toEqual(['text', 'image-ref'])
    expect(tools.map((b) => b.type)).toEqual(['tool-call', 'tool-result'])
  })
})

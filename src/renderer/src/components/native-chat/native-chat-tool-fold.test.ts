import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
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
      msg({ id: 'a', role: 'assistant', blocks: [{ type: 'text', text: 'running it' }] }),
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'done' }] })
    ])
    expect(folded).toHaveLength(1)
    expect(folded[0]?.id).toBe('a')
    expect(folded[0]?.blocks).toEqual([
      { type: 'text', text: 'running it' },
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

  it('leaves an orphan tool message standalone when no assistant precedes it', () => {
    const folded = foldToolMessages([
      msg({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'hi' }] }),
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'x' }] })
    ])
    expect(folded.map((m) => m.id)).toEqual(['u', 't'])
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

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

describe('spawn-group roster rows', () => {
  const roster = msg({
    id: 'roster',
    role: 'system',
    blocks: [
      { type: 'text', text: 'Kicked off 1 subagent — 1 working' },
      {
        type: 'subagent-group',
        groupId: 'thread:turn-1',
        agents: [{ id: 'child-1', label: 'read', state: 'working' }]
      }
    ]
  })

  it('does not end the assistant run the following tool messages fold into', () => {
    const folded = foldToolMessages([
      msg({
        id: 'a',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'working' },
          { type: 'tool-call', name: 'Bash', input: {} }
        ]
      }),
      roster,
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'done' }] })
    ])

    expect(folded.map((message) => message.id)).toEqual(['a', 'roster'])
    expect(folded[0]?.blocks.map((block) => block.type)).toEqual([
      'text',
      'tool-call',
      'tool-result'
    ])
  })

  it('survives the noise strip so the roster still reaches the transcript', () => {
    expect(stripNoiseMessages([roster]).map((message) => message.id)).toEqual(['roster'])
  })

  it('keeps the roster out of the tool array so mobile draws no empty tool run', () => {
    const { prose, tools } = splitNativeChatBlocks(roster.blocks)

    expect(tools).toEqual([])
    // The plain-text twin stays in prose: a client without the block type reads it.
    expect(prose.map((block) => block.type)).toEqual(['text', 'subagent-group'])
  })
})

describe('foldToolMessages — each agent folds into its own run', () => {
  const child = (
    overrides: Partial<NativeChatMessage> & Pick<NativeChatMessage, 'id'>
  ): NativeChatMessage => msg({ agentId: 'task-1', ...overrides })
  const text = (value: string) => ({ type: 'text' as const, text: value })
  const call = (name: string) => ({ type: 'tool-call' as const, name, input: {} })

  it("does not fold a subagent's tool calls into its parent's message", () => {
    const folded = foldToolMessages([
      msg({ id: 'parent', blocks: [text('delegating')] }),
      child({ id: 'child-grep', blocks: [call('Grep')] })
    ])
    expect(folded.map((message) => message.id)).toEqual(['parent', 'child-grep'])
    expect(folded[0]?.blocks).toEqual([text('delegating')])
  })

  it("keeps interleaved agents in order, each call in its own agent's run", () => {
    const folded = foldToolMessages([
      msg({ id: 'parent', blocks: [text('delegating')] }),
      child({ id: 'child', blocks: [text('looking')] }),
      child({ id: 'child-grep', blocks: [call('Grep')] }),
      msg({ id: 'parent-read', blocks: [call('Read')] })
    ])
    // The parent's later call stays where it happened, below the child's work,
    // rather than jumping back up into the parent's earlier row.
    expect(folded.map((message) => message.id)).toEqual(['parent', 'child', 'parent-read'])
    expect(folded[0]?.blocks).toEqual([text('delegating')])
    expect(folded[1]?.blocks).toEqual([text('looking'), call('Grep')])
    expect(folded[1]?.agentId).toBe('task-1')
    expect(folded[2]?.agentId).toBeUndefined()
  })

  it("ends every agent's run at a turn boundary", () => {
    const folded = foldToolMessages([
      child({ id: 'child', blocks: [text('looking')] }),
      msg({ id: 'ask', role: 'user', blocks: [text('next')] }),
      child({ id: 'child-grep', blocks: [call('Grep')] })
    ])
    // The child's later call stays in the turn it happened in.
    expect(folded.map((message) => message.id)).toEqual(['child', 'ask', 'child-grep'])
  })

  it('folds a transcript that names no producer exactly as a single run', () => {
    const folded = foldToolMessages([
      msg({ id: 'a', blocks: [text('one')] }),
      msg({ id: 'a-call', blocks: [call('Bash')] }),
      msg({ id: 'notice', role: 'system', blocks: [text('Something happened')] }),
      msg({ id: 'b-call', blocks: [call('Read')] })
    ])
    expect(folded.map((message) => message.id)).toEqual(['a', 'notice', 'b-call'])
    expect(folded[0]?.blocks).toEqual([text('one'), call('Bash')])
  })
})

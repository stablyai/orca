import { describe, it, expect } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

import { foldToolMessages } from '../../../../../../shared/native-chat/tools/native-chat-tool-fold'

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
  // Invisible provider events must not split visible runs; rendered plan updates do.
  it('keeps one run across a wordless provider event, but not across a plan update', () => {
    const frameRow = (id: string, kind: string): NativeChatMessage =>
      msg({
        id,
        role: 'system',
        blocks: [
          {
            type: 'text',
            text: `codex · ${kind}`,
            providerFrame: {
              provider: 'codex',
              kind,
              payload: { head: '{}', byteLength: 2, digest: 'digest', truncated: false }
            }
          }
        ]
      })
    const run = (between: NativeChatMessage): string[] =>
      foldToolMessages([
        msg({
          id: 'a1',
          blocks: [
            { type: 'text', text: 'go' },
            { type: 'tool-call', name: 'Bash', input: {} }
          ]
        }),
        msg({ id: 'r1', role: 'tool', blocks: [{ type: 'tool-result', output: 'ok' }] }),
        between,
        msg({ id: 'a2', blocks: [{ type: 'tool-call', name: 'Bash', input: {} }] }),
        msg({ id: 'r2', role: 'tool', blocks: [{ type: 'tool-result', output: 'ok' }] })
      ]).map((message) => message.id)
    expect(run(frameRow('frame', 'notification:future/event'))).toEqual(['a1', 'frame'])
    expect(run(frameRow('plan', 'notification:turn/plan/updated'))).toEqual(['a1', 'plan', 'a2'])
  })

  it('drops a result after a user turn abandons the pending call', () => {
    const folded = foldToolMessages([
      msg({ id: 'c', role: 'assistant', blocks: [{ type: 'tool-call', name: 'Bash', input: {} }] }),
      msg({ id: 'u', role: 'user', blocks: [{ type: 'text', text: 'stop' }] }),
      msg({ id: 't', role: 'tool', blocks: [{ type: 'tool-result', output: 'x' }] })
    ])
    expect(folded.map((m) => m.id)).toEqual(['c', 'u'])
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
})

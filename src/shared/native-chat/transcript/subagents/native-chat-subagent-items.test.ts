import { describe, expect, it } from 'vitest'
import { foldSubagentItems, subagentFallbackText } from './native-chat-subagent-items'
import { projectNativeChatTranscriptMessages } from '../native-chat-transcript-projection'
import type {
  NativeChatMessage,
  NativeChatSubagentBlock,
  NativeChatSubagentGroupBlock
} from '../../native-chat-types'

function subagent(
  id: string,
  overrides: Partial<NativeChatSubagentBlock> = {}
): NativeChatSubagentBlock {
  return { type: 'subagent', id, label: id, state: 'working', groupId: 'turn-1', ...overrides }
}

function item(sequence: number, block: NativeChatSubagentBlock): NativeChatMessage {
  return {
    id: `subagent:${block.id}`,
    role: 'system',
    blocks: [{ type: 'text', text: subagentFallbackText(block) }, block],
    timestamp: sequence,
    source: 'transcript',
    journalPosition: { sequence, index: 0 }
  }
}

function text(sequence: number, role: NativeChatMessage['role'], body: string): NativeChatMessage {
  return {
    id: `row-${sequence}`,
    role,
    blocks: [{ type: 'text', text: body }],
    timestamp: sequence,
    source: 'transcript',
    journalPosition: { sequence, index: 0 }
  }
}

function groupOf(message: NativeChatMessage | undefined): NativeChatSubagentGroupBlock {
  const [block] = message?.blocks ?? []
  if (block?.type !== 'subagent-group') {
    throw new Error('expected a roster row')
  }
  return block
}

describe('a turn’s subagents drawn as one row', () => {
  it('folds siblings into one roster row at the first one’s place, whatever lies between', () => {
    const rows = foldSubagentItems([
      text(1, 'user', 'audit it'),
      item(2, subagent('a', { label: 'Audit' })),
      text(3, 'assistant', 'and another'),
      item(4, subagent('b', { label: 'Review', state: 'completed', settledAt: 9 }))
    ])

    expect(rows.map((row) => row.id)).toEqual(['row-1', 'subagent:a', 'row-3'])
    expect(groupOf(rows[1])).toEqual({
      type: 'subagent-group',
      groupId: 'turn-1',
      agents: [
        { id: 'a', label: 'Audit', state: 'working' },
        { id: 'b', label: 'Review', state: 'completed', settledAt: 9 }
      ]
    })
  })

  it('keeps another turn’s, or another spawner’s, subagents in rows of their own', () => {
    const rows = foldSubagentItems([
      item(1, subagent('a')),
      item(2, subagent('b', { groupId: 'turn-2' })),
      item(3, subagent('c', { parentId: 'a' }))
    ])

    expect(rows.map((row) => groupOf(row).agents.map((agent) => agent.id))).toEqual([
      ['a'],
      ['b'],
      ['c']
    ])
    // The phone keys a group's open state by groupId, so a helper's helpers get their own.
    expect(new Set(rows.map((row) => groupOf(row).groupId)).size).toBe(3)
  })

  it('leaves an older host’s roster row, and rows that are not one subagent, as they came', () => {
    const roster: NativeChatMessage = {
      ...text(1, 'system', 'Ran 1 subagent'),
      blocks: [
        { type: 'text', text: 'Ran 1 subagent' },
        {
          type: 'subagent-group',
          groupId: 'turn-0',
          agents: [{ id: 'old', label: 'old', state: 'completed' }]
        }
      ]
    }
    const mixed: NativeChatMessage = {
      ...text(2, 'assistant', 'x'),
      blocks: [subagent('z'), { type: 'tool-call', name: 'Agent', input: {} }]
    }
    const messages = [roster, mixed]
    expect(foldSubagentItems(messages)).toBe(messages)
  })

  it('is what the transcript draws, so the row folds no tool run apart', () => {
    const rows = projectNativeChatTranscriptMessages([
      text(1, 'user', 'go'),
      {
        ...text(2, 'assistant', ''),
        blocks: [{ type: 'tool-call', name: 'Agent', input: {}, callId: 'c1' }]
      },
      item(3, subagent('a')),
      { ...text(4, 'tool', ''), blocks: [{ type: 'tool-result', output: 'ok', callId: 'c1' }] }
    ])

    expect(rows.map((row) => row.blocks.map((block) => block.type))).toEqual([
      ['text'],
      ['tool-call', 'tool-result'],
      ['subagent-group']
    ])
  })
})

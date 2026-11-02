import { describe, expect, it } from 'vitest'
import {
  foldSubagentItems,
  namedSubagents,
  subagentFallbackText
} from './native-chat-subagent-items'
import { projectNativeChatTranscriptMessages } from './native-chat-transcript-projection'
import { formatWorkerTranscriptMessage } from './worker-transcript-text'
import type {
  NativeChatMessage,
  NativeChatSubagentBlock,
  NativeChatSubagentGroupBlock
} from './native-chat-types'

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

  it('tells same-named siblings apart without taking a name a sibling already has', () => {
    const rows = foldSubagentItems([
      item(1, subagent('a', { label: 'Audit' })),
      item(2, subagent('b', { label: 'Audit' })),
      item(3, subagent('c', { label: 'Audit 2' }))
    ])

    expect(groupOf(rows[0]).agents.map((agent) => agent.label)).toEqual([
      'Audit',
      'Audit 3',
      'Audit 2'
    ])
  })

  it('hands back the same row while no sibling changed, and a new one when one did', () => {
    const a = item(1, subagent('a'))
    const b = item(2, subagent('b'))
    const first = foldSubagentItems([a, b])[0]
    expect(foldSubagentItems([a, b])[0]).toBe(first)

    const settled = item(2, subagent('b', { state: 'completed' }))
    const next = foldSubagentItems([a, settled])[0]
    expect(next).not.toBe(first)
    // The sibling that did not change keeps its line, so its memoized row stays put.
    expect(groupOf(next).agents[0]).toBe(groupOf(first).agents[0])
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

describe('the sentence an older client draws', () => {
  it('claims no liveness it cannot keep, and names an adverse outcome', () => {
    expect(subagentFallbackText(subagent('a', { label: 'Audit' }))).toBe(
      'Kicked off subagent Audit'
    )
    expect(subagentFallbackText(subagent('a', { label: 'Audit', state: 'completed' }))).toBe(
      'Ran subagent Audit'
    )
    expect(subagentFallbackText(subagent('a', { label: 'Audit', state: 'failed' }))).toBe(
      'Ran subagent Audit (failed)'
    )
  })

  it('is what a text surface prints, once, and the block alone still prints it', () => {
    const own = item(1, subagent('a', { label: 'Audit' }))
    expect(formatWorkerTranscriptMessage(own)).toBe('[system] Kicked off subagent Audit')
    expect(formatWorkerTranscriptMessage({ ...own, blocks: own.blocks.slice(1) })).toBe(
      '[system] [subagents] Kicked off subagent Audit'
    )
  })
})

describe('the subagents a row names', () => {
  it('reads an older host’s roster and a subagent’s own row alike', () => {
    expect(
      namedSubagents(subagent('a', { run: 'r', outcomeBasis: 'stop-acknowledged', tokens: 3 }))
    ).toEqual([{ id: 'a', label: 'a', state: 'working', tokens: 3 }])
    expect(
      namedSubagents({
        type: 'subagent-group',
        groupId: 'g',
        agents: [{ id: 'b', label: 'b', state: 'idle' }]
      })
    ).toEqual([{ id: 'b', label: 'b', state: 'idle' }])
    expect(namedSubagents({ type: 'text', text: 'x' })).toEqual([])
  })
})

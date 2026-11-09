import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatSubagentSections } from './native-chat-subagent-sections'
import { nativeChatSubagentLiveSections } from './native-chat-subagent-live-frontier'

function message(
  id: string,
  blocks: NativeChatMessage['blocks'],
  sequence: number,
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks,
    timestamp: 1,
    source: 'transcript',
    journalPosition: { sequence, index: 0 },
    ...extra
  }
}

function handoff(index: number, agents = ['child']): NativeChatMessage {
  return message(
    `handoff-${index}`,
    [
      {
        type: 'tool-call',
        name: 'wait_agent',
        input: {
          agents,
          future: { reason: 'observe', unicode: '🙂' },
          optional: undefined
        }
      }
    ],
    index + 10
  )
}

function fixture(calls: readonly NativeChatMessage[]) {
  const roster = message(
    'root-roster',
    [
      {
        type: 'subagent-group',
        groupId: 'root',
        agents: [{ id: 'parent', label: 'parent', state: 'working' }]
      }
    ],
    1,
    { role: 'system' }
  )
  const parent = message('parent-row', [{ type: 'text', text: 'delegating' }], 2, {
    agentId: 'parent',
    producerKind: 'agent'
  })
  const child = message('child-row', [{ type: 'text', text: 'reading' }], 3, {
    agentId: 'child',
    parentAgentId: 'parent',
    producerKind: 'agent'
  })
  const conversation = [roster, ...calls]
  const sections = nativeChatSubagentSections(
    conversation,
    new Map([
      ['parent', [{ message: parent, turnKey: undefined }]],
      ['child', [{ message: child, turnKey: undefined }]]
    ])
  )
  return { conversation, sections, roster, parent, child }
}

describe('nested subagent handoff accumulation', () => {
  it.each([{ agents: [] }, { agents: [''] }, { agents: ['unknown'] }])(
    'keeps unknown or empty target behavior for %j',
    ({ agents }) => {
      const input = fixture([handoff(0), handoff(1, agents)])
      const before = structuredClone(input)
      expect([...nativeChatSubagentLiveSections(input.conversation, input.sections, true)]).toEqual(
        ['child']
      )
      expect(input).toEqual(before)
    }
  )

  it('keeps live ordering for interleaved handoffs to different nested scopes', () => {
    const input = fixture([handoff(0), handoff(1, ['other-child']), handoff(2)])
    const group = input.roster.blocks[0]
    if (group?.type !== 'subagent-group') {
      throw new Error('Missing root roster')
    }
    group.agents.push({ id: 'other-parent', label: 'other parent', state: 'working' })
    const otherParent = message('other-parent-row', [{ type: 'text', text: 'delegating' }], 4, {
      agentId: 'other-parent',
      producerKind: 'agent'
    })
    const otherChild = message('other-child-row', [{ type: 'text', text: 'reading' }], 5, {
      agentId: 'other-child',
      parentAgentId: 'other-parent',
      producerKind: 'agent'
    })
    const sections = nativeChatSubagentSections(
      input.conversation,
      new Map([
        ['parent', [{ message: input.parent, turnKey: undefined }]],
        ['child', [{ message: input.child, turnKey: undefined }]],
        ['other-parent', [{ message: otherParent, turnKey: undefined }]],
        ['other-child', [{ message: otherChild, turnKey: undefined }]]
      ])
    )
    const before = structuredClone({ input, sections })
    expect([...nativeChatSubagentLiveSections(input.conversation, sections, true)]).toEqual([
      'other-parent',
      'child',
      'other-child'
    ])
    expect({ input, sections }).toEqual(before)
  })

  it('derives fresh results on interleaved sessions with identical IDs and no carried handoffs', () => {
    const waiting = fixture([handoff(0)])
    const plain = fixture([])
    expect([
      ...nativeChatSubagentLiveSections(waiting.conversation, waiting.sections, true)
    ]).toEqual(['parent', 'child'])
    expect([...nativeChatSubagentLiveSections(plain.conversation, plain.sections, true)]).toEqual([
      'parent'
    ])
    expect([
      ...nativeChatSubagentLiveSections(waiting.conversation, waiting.sections, true)
    ]).toEqual(['parent', 'child'])
    expect(nativeChatSubagentLiveSections(waiting.conversation, waiting.sections, false)).toBe(
      nativeChatSubagentLiveSections(plain.conversation, plain.sections, false)
    )
  })
})

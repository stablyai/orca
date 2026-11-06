import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../native-chat-types'
import { nativeChatListedSubagents, nativeChatSubagentActivities } from './native-chat-activity'

function message(
  id: string,
  blocks: NativeChatMessage['blocks'],
  extra: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return { id, role: 'assistant', timestamp: 1, source: 'transcript', blocks, ...extra }
}

describe('nativeChatSubagentActivities', () => {
  it('lists roster state and the child transcript’s latest line', () => {
    const conversation = [
      message('roster', [
        {
          type: 'subagent-group',
          groupId: 'turn-1',
          agents: [
            { id: 'child-1', label: 'Explore', state: 'working' },
            { id: 'child-2', label: 'Review', state: 'completed' }
          ]
        }
      ])
    ]
    const child = message(
      'line',
      [
        { type: 'text', text: 'Kicked off subagent Explore' },
        { type: 'tool-call', name: 'Read', input: {} },
        { type: 'text', text: 'Found the composer pill.' }
      ],
      { agentId: 'child-1', producerKind: 'agent' }
    )
    const activities = nativeChatSubagentActivities(
      conversation,
      new Map([['child-1', [{ message: child }]]])
    )
    expect(activities).toEqual([
      {
        id: 'child-1',
        label: 'Explore',
        state: 'working',
        activity: 'Found the composer pill.'
      },
      { id: 'child-2', label: 'Review', state: 'completed', activity: null }
    ])
  })
})

describe('nativeChatListedSubagents', () => {
  it('keeps running and failed children and drops completed, idle, and cancelled', () => {
    const roster = (
      [
        ['run', 'working'],
        ['wait', 'idle'],
        ['done', 'completed'],
        ['bad', 'failed'],
        ['stop', 'stopped'],
        ['lost', 'unverifiable']
      ] as const
    ).map(([id, state]) => ({ id, label: id, state, activity: null }))
    expect(nativeChatListedSubagents(roster).map((entry) => entry.id)).toEqual([
      'run',
      'bad',
      'lost'
    ])
  })
})

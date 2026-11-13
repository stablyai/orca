import { describe, expect, it } from 'vitest'
import type { NativeChatSubagentRow } from '../../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import { nativeChatSubagentSwitcherItems } from './native-chat-subagent-switcher-items'

function rows(id: string, parentAgentId?: string): [string, NativeChatSubagentRow[]] {
  return [
    id,
    [
      {
        message: {
          id: `${id}-row`,
          role: 'assistant',
          blocks: [],
          timestamp: 1,
          source: 'transcript',
          ...(parentAgentId ? { parentAgentId } : {})
        },
        turnKey: undefined
      }
    ]
  ]
}

describe('nativeChatSubagentSwitcherItems', () => {
  it('lists each child under the subagent that spawned it and numbers unnamed agents', () => {
    const entries = new Map([
      ['a', { id: 'a', label: 'Audit', state: 'working' as const }],
      ['b', { id: 'b', label: 'Build', state: 'completed' as const }]
    ])
    const subagentRows = new Map([rows('a'), rows('c', 'a'), rows('d', 'c'), rows('b'), rows('e')])
    expect(nativeChatSubagentSwitcherItems(entries, subagentRows, 'Subagent')).toEqual([
      { id: 'a', label: 'Audit', depth: 0 },
      { id: 'c', label: 'Subagent', depth: 1 },
      { id: 'd', label: 'Subagent 2', depth: 2 },
      { id: 'b', label: 'Build', depth: 0 },
      { id: 'e', label: 'Subagent 3', depth: 0 }
    ])
  })
})

import { describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSubagentRoster } from '../../../../shared/agent-session/view/structured-agent-session-subagent-roster'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { nativeChatSubagentPlace } from './native-chat-subagent-reveal'
import type { NativeChatSubagentSections } from './native-chat-subagent-sections'

const noSections: NativeChatSubagentSections = {
  rows: new Map(),
  entries: new Map(),
  rosters: new Map(),
  anchoredAt: new Map(),
  openAt: new Map(),
  pathOf: new Map()
}

function retained(sequence: number): StructuredAgentSubagentRoster {
  return new Map([
    ['task-a', { rosterPosition: { sequence } }]
  ]) as unknown as StructuredAgentSubagentRoster
}

describe('nativeChatSubagentPlace', () => {
  it('reads the /clear floor only when a retained spawn decides whether to page', () => {
    const loadedRow = { message: { id: 'row-1' } as NativeChatMessage }
    const loaded = { ...noSections, rows: new Map([['task-a', [loadedRow]]]) }
    const floor = vi.fn(() => 0)

    expect(
      nativeChatSubagentPlace({
        agentId: 'task-a',
        conversation: [],
        sections: loaded as unknown as NativeChatSubagentSections,
        roster: retained(1),
        slots: [],
        historyFloor: floor
      })
    ).toEqual({ kind: 'open', agentIds: ['task-a'] })
    expect(floor).not.toHaveBeenCalled()

    const place = (sequence: number, clearedAt: number) =>
      nativeChatSubagentPlace({
        agentId: 'task-a',
        conversation: [],
        sections: noSections,
        roster: retained(sequence),
        slots: [],
        historyFloor: () => clearedAt
      }).kind
    expect(place(5, 4)).toBe('page')
    expect(place(2, 4)).toBe('stop')
  })
})

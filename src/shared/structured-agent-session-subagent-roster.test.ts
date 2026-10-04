import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { NativeChatSubagentState } from './native-chat-types'
import {
  foldStructuredAgentSubagentRoster,
  NO_STRUCTURED_AGENT_SUBAGENT_ROSTER
} from './structured-agent-session-subagent-roster'

function roster(
  itemId: string,
  sequence: number,
  agents: [string, string, NativeChatSubagentState][],
  revision = 1,
  agentId?: string
): AgentJournalRenderItem {
  return {
    itemId,
    revision,
    sequence,
    observedAt: sequence,
    ...(agentId === undefined ? {} : { agentId }),
    body: {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: `group-${itemId}`,
          agents: agents.map(([id, label, state]) => ({ id, label, state }))
        }
      ]
    }
  }
}

const fold = (items: AgentJournalRenderItem[], removed: string[] = []) =>
  foldStructuredAgentSubagentRoster(NO_STRUCTURED_AGENT_SUBAGENT_ROSTER, items, removed)

describe('the client roster of subagents', () => {
  it('names each agent from the first roster row naming it, and takes that row’s revisions', () => {
    const first = fold([roster('r-2', 5, [['a', 'resumed', 'working']])])
    const named = foldStructuredAgentSubagentRoster(first, [
      roster('r-1', 2, [['a', 'review', 'working']])
    ])
    expect(named.get('a')).toMatchObject({ rosterItemId: 'r-1', entry: { label: 'review' } })

    const settled = foldStructuredAgentSubagentRoster(named, [
      roster('r-1', 2, [['a', 'review', 'completed']], 2),
      roster('r-2', 5, [['a', 'resumed', 'failed']], 2)
    ])
    expect(settled.get('a')?.entry.state).toBe('completed')
    expect(settled.get('a')?.rosterPosition).toEqual({ sequence: 2, index: 0 })
  })

  it('keeps its identity when nothing it holds changed', () => {
    const named = fold([roster('r-1', 2, [['a', 'review', 'working']])])
    expect(
      foldStructuredAgentSubagentRoster(named, [roster('r-1', 2, [['a', 'review', 'working']])])
    ).toBe(named)
  })

  it('reads only the session’s own roster rows', () => {
    expect(fold([roster('r-1', 2, [['b', 'nested', 'working']], 1, 'a')]).size).toBe(0)
  })

  it('drops the agents a removed roster row named', () => {
    const named = fold([
      roster('r-1', 2, [['a', 'review', 'working']]),
      roster('r-2', 3, [['b', 'tests', 'working']])
    ])
    expect([...foldStructuredAgentSubagentRoster(named, [], ['r-1']).keys()]).toEqual(['b'])
  })

  it('drops an agent a newer revision of its roster row stops naming, and only a newer one', () => {
    const named = fold([
      roster('r-1', 2, [
        ['a', 'review', 'working'],
        ['b', 'tests', 'working']
      ])
    ])
    const stale = foldStructuredAgentSubagentRoster(named, [
      roster('r-1', 2, [['b', 'tests', 'working']], 1)
    ])
    expect([...stale.keys()]).toEqual(['a', 'b'])
    const revised = foldStructuredAgentSubagentRoster(named, [
      roster('r-1', 2, [['b', 'tests', 'completed']], 2)
    ])
    expect([...revised.keys()]).toEqual(['b'])
    // Another roster naming the agent takes it over, as the window's rows would name it.
    expect(
      foldStructuredAgentSubagentRoster(named, [
        roster('r-2', 5, [['a', 'resumed', 'working']]),
        roster('r-1', 2, [['b', 'tests', 'completed']], 2)
      ]).get('a')
    ).toMatchObject({ rosterItemId: 'r-2' })
  })

  it('holds a bounded number of agents, the newest-named kept', () => {
    const many = Array.from({ length: 600 }, (_, index) =>
      roster(`r-${index}`, index + 1, [[`agent-${index}`, 'x', 'completed']])
    )
    const named = fold(many)
    expect(named.size).toBe(512)
    expect(named.has('agent-599')).toBe(true)
    expect(named.has('agent-0')).toBe(false)
  })
})

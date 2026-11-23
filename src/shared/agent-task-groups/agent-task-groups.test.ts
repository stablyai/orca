import { describe, expect, it } from 'vitest'
import {
  assignTabToAgentTaskGroup,
  createAgentTaskGroup,
  deleteAgentTaskGroup,
  normalizeAgentTaskGroupsByWorkspace
} from './agent-task-groups'

const WS = 'local\u0000wt-1'

describe('agent task groups persistence', () => {
  it('survives a persisted round trip and rejects malformed rows without losing valid ones', () => {
    let state = createAgentTaskGroup({}, WS, {
      id: 'g1',
      name: '  Model  Development ',
      createdAt: 1
    })
    state = createAgentTaskGroup(state, WS, { id: 'g2', name: 'Final Submission', createdAt: 2 })
    state = assignTabToAgentTaskGroup(state, WS, 'tab-a', 'g1')
    state = assignTabToAgentTaskGroup(state, WS, 'tab-b', 'g2')

    const persisted: unknown = JSON.parse(JSON.stringify(state))
    expect(normalizeAgentTaskGroupsByWorkspace(persisted)).toEqual(state)
    expect(state[WS].groups.map((group) => group.name)).toEqual([
      'Model Development',
      'Final Submission'
    ])

    const corrupted = {
      [WS]: {
        groups: [
          state[WS].groups[0],
          { id: 'g1', name: 'duplicate id' },
          { id: 'g3', name: '   ' },
          'not-a-group'
        ],
        groupIdByTabId: { 'tab-a': 'g1', 'tab-b': 'g2', 'tab-c': 42 }
      },
      'empty-workspace': { groups: [], groupIdByTabId: { 'tab-z': 'g9' } },
      broken: 'nope'
    }
    expect(normalizeAgentTaskGroupsByWorkspace(corrupted)).toEqual({
      [WS]: { groups: [state[WS].groups[0]], groupIdByTabId: { 'tab-a': 'g1' } }
    })
    expect(normalizeAgentTaskGroupsByWorkspace(null)).toEqual({})
  })

  it('deleting a group only ungroups its own conversations', () => {
    let state = createAgentTaskGroup({}, WS, { id: 'g1', name: 'A', createdAt: 1 })
    state = createAgentTaskGroup(state, WS, { id: 'g2', name: 'B', createdAt: 2 })
    state = assignTabToAgentTaskGroup(state, WS, 'tab-a', 'g1')
    state = assignTabToAgentTaskGroup(state, WS, 'tab-b', 'g2')

    const afterDelete = deleteAgentTaskGroup(state, WS, 'g1')
    expect(afterDelete[WS]).toEqual({
      groups: [state[WS].groups[1]],
      groupIdByTabId: { 'tab-b': 'g2' }
    })
    // Removing the last group drops the workspace entry entirely.
    expect(deleteAgentTaskGroup(afterDelete, WS, 'g2')).toEqual({})
  })
})

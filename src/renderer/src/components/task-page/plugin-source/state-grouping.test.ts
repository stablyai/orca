import { describe, expect, it } from 'vitest'

import type { PluginTaskItem } from '../../../../../shared/plugins/plugin-task-source-contract'
import { groupPluginTaskItemsByState } from './state-grouping'

function item(id: string, state: PluginTaskItem['state']): PluginTaskItem {
  return {
    id,
    key: id,
    title: id,
    state,
    assignee: null,
    url: null,
    updatedAt: null,
    scopeId: null
  }
}

describe('groupPluginTaskItemsByState', () => {
  it('groups by state name and counts each group', () => {
    const sections = groupPluginTaskItemsByState([
      item('a', { name: 'In Progress', category: 'in-progress' }),
      item('b', { name: 'To Do', category: 'todo' }),
      item('c', { name: 'In Progress', category: 'in-progress' })
    ])

    expect(sections.map((section) => [section.label, section.items.length])).toEqual([
      ['To Do', 1],
      ['In Progress', 2]
    ])
  })

  it('orders workflow categories ahead of unknown, whatever the state names are', () => {
    const sections = groupPluginTaskItemsByState([
      item('a', { name: 'Zzz', category: 'unknown' }),
      item('b', { name: 'Shipped', category: 'done' }),
      item('c', { name: 'Backlog', category: 'todo' })
    ])

    expect(sections.map((section) => section.label)).toEqual(['Backlog', 'Shipped', 'Zzz'])
  })

  it('returns no sections for an empty board', () => {
    expect(groupPluginTaskItemsByState([])).toEqual([])
  })
})

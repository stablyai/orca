import { describe, expect, it } from 'vitest'
import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemTypeMetadata
} from '../../../shared/azure-devops/boards-types'
import {
  excludeInProgressItems,
  isInProgressWorkItem
} from './task-page-azure-devops-backlog-in-progress'

function item(
  id: number,
  state: string,
  workItemType = 'Product Backlog Item'
): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType,
    title: `Item ${id}`,
    state,
    assignedTo: null,
    areaPath: 'P',
    iterationPath: 'P',
    tags: [],
    parentId: null,
    stackRank: id,
    url: '',
    fields: {}
  }
}

const types: Record<string, AzureDevOpsWorkItemTypeMetadata> = {
  'Product Backlog Item': {
    name: 'Product Backlog Item',
    color: null,
    iconId: null,
    iconUrl: null,
    states: [
      { name: 'New', color: null, category: 'Proposed' },
      { name: 'Committed', color: null, category: 'InProgress' },
      { name: 'Done', color: null, category: 'Completed' }
    ]
  },
  Task: {
    name: 'Task',
    color: null,
    iconId: null,
    iconUrl: null,
    states: [
      { name: 'To Do', color: null, category: 'Proposed' },
      { name: 'In Progress', color: null, category: 'InProgress' }
    ]
  }
}

const page: AzureDevOpsBacklogPage = {
  level: {
    id: 'req',
    name: 'Backlog items',
    rank: 2,
    kind: 'requirement',
    workItemTypes: [],
    columnFields: [],
    hidden: false
  },
  items: [item(1, 'New'), item(2, 'Committed'), item(3, 'Done')],
  childrenByParent: { 1: [11, 12], 2: [21], 3: [] },
  children: [item(11, 'To Do', 'Task'), item(12, 'In Progress', 'Task'), item(21, 'To Do', 'Task')],
  parents: [item(70, 'Committed', 'Feature')]
}

describe('isInProgressWorkItem', () => {
  it('reads the state category from the type metadata and defaults to false', () => {
    expect(isInProgressWorkItem(item(1, 'Committed'), types)).toBe(true)
    expect(isInProgressWorkItem(item(1, 'New'), types)).toBe(false)
    expect(isInProgressWorkItem(item(1, 'Active', 'Unknown'), types)).toBe(false)
  })
})

describe('excludeInProgressItems', () => {
  it('drops in-progress level items with their children and in-progress children on their own', () => {
    const result = excludeInProgressItems(page, types)
    expect(result.items.map((i) => i.id)).toEqual([1, 3])
    expect(result.childrenByParent).toEqual({ 1: [11], 3: [] })
    expect(result.children.map((c) => c.id)).toEqual([11, 21])
    // Why: parents come from a level above; the toggle only governs the level itself.
    expect(result.parents).toBe(page.parents)
  })
})

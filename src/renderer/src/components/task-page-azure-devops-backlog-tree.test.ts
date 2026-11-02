import { describe, expect, it } from 'vitest'
import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import { buildBacklogRows } from './task-page-azure-devops-backlog-tree'

function item(id: number, type: string, parentId: number | null = null): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: type,
    title: `${type} ${id}`,
    state: 'New',
    assignedTo: null,
    areaPath: '',
    iterationPath: '',
    tags: [],
    parentId,
    stackRank: id,
    url: '',
    fields: {}
  }
}

const page: AzureDevOpsBacklogPage = {
  level: {
    id: 'req',
    name: 'Backlog items',
    rank: 2,
    kind: 'requirement',
    workItemTypes: ['PBI'],
    columnFields: [],
    hidden: false
  },
  items: [item(10, 'PBI', 70), item(11, 'PBI', null), item(12, 'PBI', 70)],
  childrenByParent: { 10: [101], 11: [], 12: [] },
  children: [item(101, 'Task', 10)],
  parents: [item(70, 'Feature')]
}

describe('buildBacklogRows', () => {
  it('flattens the level in order with collapsed children hidden', () => {
    const rows = buildBacklogRows(page, {
      showParents: false,
      toggled: new Set(),
      unparentedLabel: 'Unparented'
    })
    expect(
      rows.map((r) => (r.kind === 'group' ? r.key : `${r.kind}:${r.item.id}:${r.depth}`))
    ).toEqual(['item:10:0', 'item:11:0', 'item:12:0'])
    expect(rows[0]).toMatchObject({ hasChildren: true, expanded: false })
  })

  it('inserts children under an expanded row', () => {
    const rows = buildBacklogRows(page, {
      showParents: false,
      toggled: new Set([10]),
      unparentedLabel: 'Unparented'
    })
    expect(
      rows.map((r) => (r.kind === 'group' ? r.key : `${r.kind}:${r.item.id}:${r.depth}`))
    ).toEqual(['item:10:0', 'child:101:1', 'item:11:0', 'item:12:0'])
  })

  it('groups under expanded-by-default parents in parent order and appends an unparented group when showParents is on', () => {
    const rows = buildBacklogRows(page, {
      showParents: true,
      toggled: new Set([10]),
      unparentedLabel: 'Unparented Backlog items'
    })
    expect(
      rows.map((r) => (r.kind === 'group' ? r.key : `${r.kind}:${r.item.id}:${r.depth}`))
    ).toEqual(['parent:70:0', 'item:10:1', 'child:101:2', 'item:12:1', 'unparented', 'item:11:1'])
    expect(rows[0]).toMatchObject({ kind: 'parent', expanded: true })
    expect(rows[4]).toEqual({
      key: 'unparented',
      kind: 'group',
      label: 'Unparented Backlog items',
      depth: 0
    })
  })

  it('collapses a parent group the user toggled', () => {
    const rows = buildBacklogRows(page, {
      showParents: true,
      toggled: new Set([70]),
      unparentedLabel: 'U'
    })
    expect(rows[0]).toMatchObject({ kind: 'parent', expanded: false })
    expect(rows.map((r) => (r.kind === 'group' ? r.key : `${r.kind}:${r.item.id}`))).toEqual([
      'parent:70',
      'unparented',
      'item:11'
    ])
  })
})

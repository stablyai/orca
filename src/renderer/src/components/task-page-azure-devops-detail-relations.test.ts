import { describe, expect, it } from 'vitest'
import type {
  AzureDevOpsWorkItem,
  AzureDevOpsWorkItemDetail
} from '../../../shared/azure-devops/boards-types'
import { resolveAzureDevOpsDetailRelations } from './task-page-azure-devops-detail-relations'

function item(id: number, title = `Item ${id}`): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'Task',
    title,
    state: 'To Do',
    assignedTo: null,
    areaPath: 'Project\\Web',
    iterationPath: 'Project',
    tags: [],
    parentId: null,
    stackRank: id,
    url: '',
    fields: {}
  }
}

function detail(overrides: Partial<AzureDevOpsWorkItemDetail> = {}): AzureDevOpsWorkItemDetail {
  return {
    ...item(101, 'Card on the board'),
    workItemType: 'Product Backlog Item',
    descriptionHtml: null,
    acceptanceCriteriaHtml: null,
    childIds: [],
    pullRequestLinks: [],
    createdDate: null,
    changedDate: null,
    ...overrides
  }
}

describe('resolveAzureDevOpsDetailRelations', () => {
  it('lists children the loaded view does not hold, as the Board never loads them', () => {
    // The Board's map holds its cards and their off-board parents, never the level below.
    const resolved = resolveAzureDevOpsDetailRelations({
      detail: detail({ childIds: [301, 302], children: [item(301), item(302)] }),
      itemById: new Map([[101, item(101)]])
    })
    expect(resolved.childItems.map((c) => c.id)).toEqual([301, 302])
  })

  it('prefers the view’s own item over the one that came with the detail', () => {
    const resolved = resolveAzureDevOpsDetailRelations({
      detail: detail({ childIds: [301], children: [item(301, 'Stale copy')] }),
      itemById: new Map([[301, item(301, 'Loaded by the backlog')]])
    })
    expect(resolved.childItems.map((c) => c.title)).toEqual(['Loaded by the backlog'])
  })

  it('keeps the order of childIds and drops ids nothing could resolve', () => {
    const resolved = resolveAzureDevOpsDetailRelations({
      detail: detail({ childIds: [302, 999, 301], children: [item(301), item(302)] }),
      itemById: new Map()
    })
    expect(resolved.childItems.map((c) => c.id)).toEqual([302, 301])
  })

  it('resolves the parent from the loaded view, and nothing without a parent', () => {
    expect(
      resolveAzureDevOpsDetailRelations({
        detail: detail({ parentId: 70 }),
        itemById: new Map([[70, item(70, 'Feature')]])
      }).parent?.title
    ).toBe('Feature')
    expect(
      resolveAzureDevOpsDetailRelations({ detail: detail(), itemById: new Map() }).parent
    ).toBeNull()
    expect(resolveAzureDevOpsDetailRelations({ detail: null, itemById: new Map() })).toEqual({
      parent: null,
      childItems: []
    })
  })
})

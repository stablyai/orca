import { describe, expect, it } from 'vitest'
import type {
  AzureDevOpsBacklogPage,
  AzureDevOpsWorkItem
} from '../../../shared/azure-devops/boards-types'
import {
  EMPTY_BACKLOG_FILTERS,
  filterBacklogPage,
  matchesBacklogFilters
} from './task-page-azure-devops-backlog-filters'

function item(id: number, overrides: Partial<AzureDevOpsWorkItem> = {}): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'PBI',
    title: `Item ${id}`,
    state: 'New',
    assignedTo: null,
    areaPath: 'P\\Web',
    iterationPath: 'P\\2026\\Sprint 1',
    tags: [],
    parentId: null,
    stackRank: id,
    url: '',
    fields: {},
    ...overrides
  }
}

describe('matchesBacklogFilters', () => {
  it('matches everything with empty filters', () => {
    expect(matchesBacklogFilters(item(1), EMPTY_BACKLOG_FILTERS)).toBe(true)
  })

  it('matches keyword against title and id, case-insensitively', () => {
    expect(
      matchesBacklogFilters(item(42, { title: 'Fix Login' }), {
        ...EMPTY_BACKLOG_FILTERS,
        keyword: 'login'
      })
    ).toBe(true)
    expect(matchesBacklogFilters(item(42), { ...EMPTY_BACKLOG_FILTERS, keyword: '42' })).toBe(true)
    expect(matchesBacklogFilters(item(42), { ...EMPTY_BACKLOG_FILTERS, keyword: 'zzz' })).toBe(
      false
    )
  })

  it('matches iteration by path prefix so a parent iteration includes its sprints', () => {
    expect(
      matchesBacklogFilters(item(1), { ...EMPTY_BACKLOG_FILTERS, iterationPath: 'P\\2026' })
    ).toBe(true)
    expect(
      matchesBacklogFilters(item(1), { ...EMPTY_BACKLOG_FILTERS, iterationPath: 'P\\2025' })
    ).toBe(false)
    expect(
      matchesBacklogFilters(item(1, { iterationPath: 'P\\20260' }), {
        ...EMPTY_BACKLOG_FILTERS,
        iterationPath: 'P\\2026'
      })
    ).toBe(false)
  })

  it('matches sets for type, assignee, state, area and tags', () => {
    const it1 = item(1, {
      workItemType: 'Bug',
      state: 'Approved',
      tags: ['a', 'b'],
      assignedTo: { displayName: 'Ada', uniqueName: 'y@x', imageUrl: null }
    })
    expect(
      matchesBacklogFilters(it1, { ...EMPTY_BACKLOG_FILTERS, workItemTypes: new Set(['Bug']) })
    ).toBe(true)
    expect(
      matchesBacklogFilters(it1, { ...EMPTY_BACKLOG_FILTERS, workItemTypes: new Set(['PBI']) })
    ).toBe(false)
    expect(
      matchesBacklogFilters(it1, { ...EMPTY_BACKLOG_FILTERS, assignedTo: new Set(['y@x']) })
    ).toBe(true)
    expect(
      matchesBacklogFilters(it1, { ...EMPTY_BACKLOG_FILTERS, states: new Set(['Approved']) })
    ).toBe(true)
    expect(
      matchesBacklogFilters(it1, { ...EMPTY_BACKLOG_FILTERS, areaPaths: new Set(['P\\Web']) })
    ).toBe(true)
    expect(matchesBacklogFilters(it1, { ...EMPTY_BACKLOG_FILTERS, tags: new Set(['b']) })).toBe(
      true
    )
    expect(matchesBacklogFilters(it1, { ...EMPTY_BACKLOG_FILTERS, tags: new Set(['zzz']) })).toBe(
      false
    )
  })
})

describe('filterBacklogPage', () => {
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
    items: [item(10, { title: 'keep' }), item(11, { title: 'drop' })],
    childrenByParent: { 10: [101], 11: [111] },
    children: [
      item(101, { title: 'child keep', parentId: 10 }),
      item(111, { title: 'keep child of dropped', parentId: 11 })
    ],
    parents: []
  }

  it('keeps an item when it or any child matches, and prunes children that do not match', () => {
    const filtered = filterBacklogPage(page, { ...EMPTY_BACKLOG_FILTERS, keyword: 'keep' })
    expect(filtered.items.map((i) => i.id)).toEqual([10, 11])
    expect(filtered.childrenByParent).toEqual({ 10: [101], 11: [111] })
  })

  it('drops an item when neither it nor its children match', () => {
    const filtered = filterBacklogPage(page, { ...EMPTY_BACKLOG_FILTERS, keyword: 'child keep' })
    expect(filtered.items.map((i) => i.id)).toEqual([10])
    expect(filtered.childrenByParent).toEqual({ 10: [101] })
  })
})

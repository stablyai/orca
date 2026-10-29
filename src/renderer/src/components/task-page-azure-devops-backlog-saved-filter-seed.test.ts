import { describe, expect, it } from 'vitest'
import type { AzureDevOpsWorkItem } from '../../../shared/azure-devops/boards-types'
import {
  matchesBacklogFilters,
  UNASSIGNED_FILTER_VALUE
} from './task-page-azure-devops-backlog-filters'
import { seedBacklogFiltersFromSaved } from './task-page-azure-devops-backlog-saved-filter-seed'

function item(id: number, assignedTo: AzureDevOpsWorkItem['assignedTo']): AzureDevOpsWorkItem {
  return {
    id,
    rev: 1,
    workItemType: 'Bug',
    title: `Item ${id}`,
    state: 'New',
    assignedTo,
    areaPath: 'P',
    iterationPath: 'P\\2026',
    tags: ['urgent'],
    parentId: null,
    stackRank: id,
    url: '',
    fields: {}
  }
}

const ada = item(1, { displayName: 'Ada Lovelace', uniqueName: 'ada@x', imageUrl: null })

describe('seedBacklogFiltersFromSaved', () => {
  it('maps every ADO key, resolving assignee display names through the page items', () => {
    const filters = seedBacklogFiltersFromSaved(
      {
        keyword: 'login',
        workItemTypes: ['Bug'],
        assignedTo: ['Ada Lovelace', 'Unassigned', 'Someone Else'],
        states: ['New'],
        areaPaths: ['P'],
        iterationPaths: ['P\\2026', 'P\\2027'],
        tags: ['urgent']
      },
      [ada]
    )
    expect(filters.keyword).toBe('login')
    expect([...filters.workItemTypes]).toEqual(['Bug'])
    expect([...filters.assignedTo]).toEqual(['ada@x', UNASSIGNED_FILTER_VALUE, 'Someone Else'])
    expect([...filters.states]).toEqual(['New'])
    expect([...filters.areaPaths]).toEqual(['P'])
    expect(filters.iterationPath).toBe('P\\2026')
    expect([...filters.tags]).toEqual(['urgent'])
    expect(matchesBacklogFilters(ada, { ...filters, keyword: '' })).toBe(true)
  })

  it('still matches by display name when the assignee never resolved to a unique name', () => {
    const filters = seedBacklogFiltersFromSaved(
      {
        keyword: null,
        workItemTypes: [],
        assignedTo: ['Someone Else'],
        states: [],
        areaPaths: [],
        iterationPaths: [],
        tags: []
      },
      []
    )
    expect(filters.keyword).toBe('')
    expect(filters.iterationPath).toBeNull()
    expect(
      matchesBacklogFilters(
        item(2, { displayName: 'Someone Else', uniqueName: 'se@x', imageUrl: null }),
        filters
      )
    ).toBe(true)
    expect(matchesBacklogFilters(ada, filters)).toBe(false)
  })
})

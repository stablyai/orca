import { describe, expect, it } from 'vitest'
import type { Row } from './row-types'
import {
  collapseAllSectionKeys,
  collectSectionHeaderKeys,
  expandAllSectionKeys,
  resolveCollapseAllState
} from './section-header-keys'

describe('collectSectionHeaderKeys', () => {
  it('returns only section header keys', () => {
    const rows: Row[] = [
      { type: 'header', key: 'pinned', label: 'Pinned', count: 1, tone: 'neutral' },
      {
        type: 'pending-creation',
        key: 'pending:create-1',
        creationId: 'create-1',
        repo: undefined
      },
      { type: 'header', key: 'repo:orca', label: 'Orca', count: 2, tone: 'neutral' }
    ]

    expect(collectSectionHeaderKeys(rows)).toEqual(['pinned', 'repo:orca'])
  })

  it('returns no keys when filters hide every row, even if group headers remain', () => {
    const rows: Row[] = [
      {
        type: 'header',
        key: 'project-group:ungrouped',
        label: 'Ungrouped',
        count: 0,
        tone: 'neutral'
      }
    ]

    expect(collectSectionHeaderKeys(rows, { filtersHideAllRows: true })).toEqual([])
  })
})

describe('resolveCollapseAllState', () => {
  it('returns none when there are no section headers', () => {
    expect(resolveCollapseAllState([], new Set(['lineage:parent']))).toBe('none')
  })

  it('returns collapse when any section header is expanded', () => {
    expect(resolveCollapseAllState(['pinned', 'repo:orca'], new Set(['pinned']))).toBe('collapse')
  })

  it('returns expand when every section header is collapsed', () => {
    expect(
      resolveCollapseAllState(
        ['pinned', 'repo:orca'],
        new Set(['pinned', 'repo:orca', 'lineage:parent'])
      )
    ).toBe('expand')
  })
})

describe('collapseAllSectionKeys', () => {
  it('adds every visible header key and keeps existing entries', () => {
    expect(
      collapseAllSectionKeys(new Set(['lineage:parent', 'pinned']), ['pinned', 'repo:orca'])
    ).toEqual(new Set(['lineage:parent', 'pinned', 'repo:orca']))
  })
})

describe('expandAllSectionKeys', () => {
  it('drops section keys hidden under a collapsed parent and keeps lineage state', () => {
    // Collapsed repo R inside collapsed project group P: only P is a visible header.
    expect(expandAllSectionKeys(new Set(['project-group:P', 'repo:R', 'lineage:child']))).toEqual(
      new Set(['lineage:child'])
    )
  })

  it('returns an empty set when nothing is collapsed', () => {
    expect(expandAllSectionKeys(new Set())).toEqual(new Set())
  })
})

import { describe, expect, it } from 'vitest'
import type { GitHubProjectTable } from '../../../../shared/github-project-types'
import {
  getNextVisibleProjectTableCache,
  getVisibleProjectTable
} from './project-visible-table-cache'

function table(id: string): GitHubProjectTable {
  return { id } as unknown as GitHubProjectTable
}

describe('project visible table cache', () => {
  it('stores the filtered table while the slug index is ready', () => {
    const sourceTable = table('source')
    const filteredTable = table('filtered')

    expect(
      getNextVisibleProjectTableCache({
        currentCacheKey: 'project:view',
        sourceTable,
        slugIndexReady: true,
        filteredTable,
        previous: null
      })
    ).toEqual({ cacheKey: 'project:view', table: filteredTable })
  })

  it('keeps the previous cache while the slug index is rebuilding', () => {
    const previous = { cacheKey: 'project:view', table: table('previous') }

    expect(
      getNextVisibleProjectTableCache({
        currentCacheKey: 'project:view',
        sourceTable: table('source'),
        slugIndexReady: false,
        filteredTable: null,
        previous
      })
    ).toBe(previous)
  })

  it('drops the cache when there is no current table', () => {
    const previous = { cacheKey: 'project:view', table: table('previous') }

    expect(
      getNextVisibleProjectTableCache({
        currentCacheKey: null,
        sourceTable: null,
        slugIndexReady: false,
        filteredTable: null,
        previous
      })
    ).toBeNull()
  })

  it('shows a matching cached table while the slug index is rebuilding', () => {
    const cachedTable = { cacheKey: 'project:view', table: table('cached') }

    expect(
      getVisibleProjectTable({
        currentCacheKey: 'project:view',
        slugIndexReady: false,
        filteredTable: null,
        cachedTable
      })
    ).toBe(cachedTable.table)
  })

  it('does not show stale cached data for a different cache key', () => {
    const cachedTable = { cacheKey: 'other:view', table: table('cached') }

    expect(
      getVisibleProjectTable({
        currentCacheKey: 'project:view',
        slugIndexReady: false,
        filteredTable: null,
        cachedTable
      })
    ).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import type { GitHubProjectTable } from '../../../../shared/github-project-types'
import {
  getSelectedRepoFingerprint,
  getNextVisibleProjectTableCache,
  getVisibleProjectTable,
  getVisibleProjectTableCacheKey
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
        selectedRepoFingerprint: getSelectedRepoFingerprint(new Set(['repo-1'])),
        sourceTable,
        slugIndexReady: true,
        filteredTable,
        previous: null
      })
    ).toEqual({ cacheKey: 'project:view:selected:["repo-1"]', table: filteredTable })
  })

  it('keeps the previous cache while the slug index is rebuilding', () => {
    const previous = { cacheKey: 'project:view:selected:["repo-1"]', table: table('previous') }

    expect(
      getNextVisibleProjectTableCache({
        currentCacheKey: 'project:view',
        selectedRepoFingerprint: getSelectedRepoFingerprint(new Set(['repo-1'])),
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
        selectedRepoFingerprint: getSelectedRepoFingerprint(new Set(['repo-1'])),
        sourceTable: null,
        slugIndexReady: false,
        filteredTable: null,
        previous
      })
    ).toBeNull()
  })

  it('shows a matching cached table while the slug index is rebuilding', () => {
    const cachedTable = { cacheKey: 'project:view:selected:["repo-1"]', table: table('cached') }

    expect(
      getVisibleProjectTable({
        currentCacheKey: 'project:view',
        selectedRepoFingerprint: getSelectedRepoFingerprint(new Set(['repo-1'])),
        slugIndexReady: false,
        filteredTable: null,
        cachedTable
      })
    ).toBe(cachedTable.table)
  })

  it('does not show stale cached data for a different cache key', () => {
    const cachedTable = { cacheKey: 'other:view:selected:["repo-1"]', table: table('cached') }

    expect(
      getVisibleProjectTable({
        currentCacheKey: 'project:view',
        selectedRepoFingerprint: getSelectedRepoFingerprint(new Set(['repo-1'])),
        slugIndexReady: false,
        filteredTable: null,
        cachedTable
      })
    ).toBeNull()
  })

  it('does not show stale cached data for a different repo selection', () => {
    const cachedTable = { cacheKey: 'project:view:selected:["repo-1"]', table: table('cached') }

    expect(
      getVisibleProjectTable({
        currentCacheKey: 'project:view',
        selectedRepoFingerprint: getSelectedRepoFingerprint(new Set(['repo-2'])),
        slugIndexReady: false,
        filteredTable: null,
        cachedTable
      })
    ).toBeNull()
  })

  it('layers selection only onto the renderer visible-table cache key', () => {
    const storeCacheKey = 'organization:stablyai:1:view-id:local'

    expect(getVisibleProjectTableCacheKey(storeCacheKey, '["repo-1"]')).not.toBe(storeCacheKey)
  })
})

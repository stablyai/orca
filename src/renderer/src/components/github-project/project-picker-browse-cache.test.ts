import { beforeEach, describe, expect, it } from 'vitest'
import type { GitHubProjectSummary } from '../../../../shared/github-project-types'
import {
  PROJECT_PICKER_BROWSE_CACHE_MAX_ENTRIES,
  PROJECT_PICKER_BROWSE_CACHE_TTL_MS,
  _clearProjectPickerBrowseCacheForTest,
  _getProjectPickerBrowseCacheSizeForTest,
  getProjectPickerBrowseCacheEntry,
  peekProjectPickerBrowseCacheEntry,
  rememberProjectPickerBrowseCacheEntry
} from './project-picker-browse-cache'

function project(scope: string): GitHubProjectSummary {
  return {
    id: `${scope}-project`,
    owner: scope,
    ownerType: 'organization',
    number: 1,
    title: `${scope} Roadmap`,
    url: `https://github.com/orgs/${scope}/projects/1`,
    source: 'viewer'
  }
}

describe('project-picker-browse-cache', () => {
  beforeEach(() => {
    _clearProjectPickerBrowseCacheForTest()
  })

  it('prunes expired scopes when a different runtime is read', () => {
    rememberProjectPickerBrowseCacheEntry('runtime:old-1', { projects: [project('old-1')] }, 1_000)
    rememberProjectPickerBrowseCacheEntry('runtime:old-2', { projects: [project('old-2')] }, 900)
    rememberProjectPickerBrowseCacheEntry(
      'runtime:current',
      { projects: [project('current')] },
      2_000
    )

    expect(
      getProjectPickerBrowseCacheEntry(
        'runtime:current',
        1_000 + PROJECT_PICKER_BROWSE_CACHE_TTL_MS
      )
    ).toMatchObject({ projects: [expect.objectContaining({ owner: 'current' })] })
    expect(_getProjectPickerBrowseCacheSizeForTest()).toBe(1)
  })

  it('stays bounded through prolonged churn while preserving a reused scope', () => {
    let inserted = 1
    rememberProjectPickerBrowseCacheEntry(
      'runtime:retained',
      { projects: [project('retained')] },
      0
    )
    for (let wave = 0; wave < 4; wave += 1) {
      expect(
        getProjectPickerBrowseCacheEntry('runtime:retained', inserted)
      ).toMatchObject({ projects: [expect.objectContaining({ owner: 'retained' })] })
      for (let index = 1; index < PROJECT_PICKER_BROWSE_CACHE_MAX_ENTRIES; index += 1) {
        const scope = `scope-${inserted}`
        rememberProjectPickerBrowseCacheEntry(
          `runtime:${scope}`,
          { projects: [project(scope)] },
          inserted
        )
        inserted += 1
      }
      expect(_getProjectPickerBrowseCacheSizeForTest()).toBe(
        PROJECT_PICKER_BROWSE_CACHE_MAX_ENTRIES
      )
    }

    expect(getProjectPickerBrowseCacheEntry('runtime:retained', inserted + 1)).toMatchObject({
      projects: [expect.objectContaining({ owner: 'retained' })]
    })
    expect(getProjectPickerBrowseCacheEntry('runtime:scope-1', inserted + 1)).toBeNull()
  })

  it('peeks without changing cache recency during render', () => {
    for (let index = 0; index < PROJECT_PICKER_BROWSE_CACHE_MAX_ENTRIES; index += 1) {
      rememberProjectPickerBrowseCacheEntry(
        `runtime:${index}`,
        { projects: [project(`runtime-${index}`)] },
        index
      )
    }

    expect(peekProjectPickerBrowseCacheEntry('runtime:0', 40)).not.toBeNull()
    rememberProjectPickerBrowseCacheEntry('runtime:new', { projects: [project('new')] }, 41)

    expect(getProjectPickerBrowseCacheEntry('runtime:0', 42)).toBeNull()
  })

  it('refreshes an existing scope without growing the cache', () => {
    rememberProjectPickerBrowseCacheEntry('runtime:one', { projects: [project('old')] }, 1_000)
    rememberProjectPickerBrowseCacheEntry('runtime:one', { projects: [project('new')] }, 1_001)

    expect(_getProjectPickerBrowseCacheSizeForTest()).toBe(1)
    expect(getProjectPickerBrowseCacheEntry('runtime:one', 1_002)).toMatchObject({
      projects: [expect.objectContaining({ owner: 'new' })]
    })
  })
})

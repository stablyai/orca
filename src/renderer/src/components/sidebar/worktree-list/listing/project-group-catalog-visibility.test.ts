import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { AppState } from '../../../../store/types'
import {
  resetProjectGroupCatalogVisibilityCacheForTest,
  selectHasMultipleVisibleProjectGroupCatalogHosts
} from './project-group-catalog-visibility'

const localRepo = {
  id: 'local',
  path: '/tmp/local',
  displayName: 'Local',
  badgeColor: '#111',
  addedAt: 1,
  executionHostId: 'local'
} as Repo
const remoteRepo = {
  ...localRepo,
  id: 'remote',
  path: '/tmp/remote',
  displayName: 'Remote',
  executionHostId: 'runtime:work'
} as Repo

function visibilityState(
  repos: Repo[],
  visibleWorkspaceHostIds: AppState['visibleWorkspaceHostIds']
): Parameters<typeof selectHasMultipleVisibleProjectGroupCatalogHosts>[0] {
  return {
    repos,
    settings: null,
    visibleWorkspaceHostIds,
    workspaceHostScope: 'all'
  }
}

describe('visible project group catalog selector', () => {
  beforeEach(() => {
    resetProjectGroupCatalogVisibilityCacheForTest()
  })

  it('uses only catalogs in the visible host scope', () => {
    const repos = [localRepo, remoteRepo]

    expect(selectHasMultipleVisibleProjectGroupCatalogHosts(visibilityState(repos, null))).toBe(
      true
    )
    expect(
      selectHasMultipleVisibleProjectGroupCatalogHosts(visibilityState(repos, ['local']))
    ).toBe(false)
  })

  it('scans the catalog once while relevant state is unchanged', () => {
    const repos = [localRepo, remoteRepo]
    const filter = vi.spyOn(repos, 'filter')
    const visibleWorkspaceHostIds: AppState['visibleWorkspaceHostIds'] = ['local']
    const state = visibilityState(repos, visibleWorkspaceHostIds)

    expect(selectHasMultipleVisibleProjectGroupCatalogHosts(state)).toBe(false)
    expect(selectHasMultipleVisibleProjectGroupCatalogHosts({ ...state })).toBe(false)

    expect(filter).toHaveBeenCalledTimes(1)
  })

  it('keeps partial component stores on the single-catalog default', () => {
    expect(selectHasMultipleVisibleProjectGroupCatalogHosts({ settings: null })).toBe(false)
  })
})

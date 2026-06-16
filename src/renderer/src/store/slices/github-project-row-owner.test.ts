import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { settingsForProjectRowOwner } from './github-project-row-owner'
import { lookupReposBySlugFromCache } from '@/lib/repo-slug-cache'

vi.mock('@/lib/repo-slug-cache', () => ({
  lookupReposBySlugFromCache: vi.fn()
}))

const mockedLookup = vi.mocked(lookupReposBySlugFromCache)

function repo(id: string, executionHostId: string | null): Repo {
  return { id, executionHostId, connectionId: null } as unknown as Repo
}

describe('settingsForProjectRowOwner', () => {
  beforeEach(() => {
    mockedLookup.mockReset()
  })

  it('routes to the matched repo owner host when the slug matches', () => {
    mockedLookup.mockReturnValue([repo('repo-1', 'runtime:owner-env')])
    const state = {
      repos: [repo('repo-1', 'runtime:owner-env')],
      settings: { activeRuntimeEnvironmentId: 'focused-env' }
    }
    expect(settingsForProjectRowOwner(state, 'acme', 'widgets')).toEqual({
      activeRuntimeEnvironmentId: 'owner-env'
    })
  })

  it('falls back to focused settings when no repo matches the slug', () => {
    mockedLookup.mockReturnValue([])
    const state = {
      repos: [repo('repo-1', 'runtime:owner-env')],
      settings: { activeRuntimeEnvironmentId: 'focused-env' }
    }
    expect(settingsForProjectRowOwner(state, 'acme', 'widgets')).toEqual({
      activeRuntimeEnvironmentId: 'focused-env'
    })
  })
})

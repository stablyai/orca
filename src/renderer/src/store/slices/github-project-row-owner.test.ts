import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { runtimeTargetForProjectRowOwner } from './github-project-row-owner'
import { lookupReposBySlugFromCache } from '@/lib/repo-slug-cache'

vi.mock('@/lib/repo-slug-cache', () => ({
  lookupReposBySlugFromCache: vi.fn()
}))

const mockedLookup = vi.mocked(lookupReposBySlugFromCache)

function repo(id: string, executionHostId: string | null): Repo {
  return { id, executionHostId, connectionId: null } as unknown as Repo
}

describe('runtimeTargetForProjectRowOwner', () => {
  beforeEach(() => {
    mockedLookup.mockReset()
  })

  it('routes to the matched repo owner host when the slug matches', () => {
    mockedLookup.mockReturnValue([repo('repo-1', 'runtime:owner-env')])
    const state = {
      repos: [repo('repo-1', 'runtime:owner-env')],
      settings: { activeRuntimeEnvironmentId: 'focused-env' }
    }
    expect(
      runtimeTargetForProjectRowOwner(state, 'acme', 'widgets', undefined, { kind: 'local' })
    ).toEqual({ kind: 'environment', environmentId: 'owner-env' })
  })

  it('falls back to the host the row was loaded from, not focus, when no repo matches', () => {
    mockedLookup.mockReturnValue([])
    const state = {
      repos: [repo('repo-1', 'runtime:owner-env')],
      settings: { activeRuntimeEnvironmentId: 'focused-env' }
    }
    expect(
      runtimeTargetForProjectRowOwner(state, 'acme', 'widgets', undefined, {
        kind: 'environment',
        environmentId: 'board-env'
      })
    ).toEqual({ kind: 'environment', environmentId: 'board-env' })
  })
})

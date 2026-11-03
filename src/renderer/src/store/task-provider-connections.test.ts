import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { createTestStore } from './slices/store-test-helpers'
import { selectTaskProviderConnections } from './task-provider-connections'

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => undefined,
  getLocalPreflightTarget: () => ({ kind: 'local' }),
  localPreflightContextKey: () => 'local'
}))

function repo(id: string, executionHostId?: Repo['executionHostId']): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: 'gray',
    addedAt: 1,
    kind: 'git',
    ...(executionHostId ? { executionHostId } : {})
  }
}

function state(repos: Repo[]) {
  const store = createTestStore()
  store.setState({
    repos,
    preflightStatus: {
      git: { installed: true },
      gh: { installed: true, authenticated: false },
      glab: { installed: true, authenticated: false }
    },
    preflightStatusChecked: true,
    preflightStatusContextKey: 'local',
    preflightStatusLoading: false,
    preflightStatusError: null
  })
  return store.getState()
}

describe('selectTaskProviderConnections', () => {
  it('settles GitHub and GitLab when every repo runs on the checked runtime', () => {
    expect(selectTaskProviderConnections(state([repo('local-repo')]))).toEqual({
      github: false,
      gitlab: false
    })
  })

  it('keeps GitHub and GitLab pending while a repo runs on another runtime', () => {
    const repos = [repo('local-repo'), repo('remote-repo', 'runtime:env-2')]

    expect(selectTaskProviderConnections(state(repos))).toEqual({})
    expect(selectTaskProviderConnections(state(repos), [repos[0]])).toEqual({
      github: false,
      gitlab: false
    })
  })
})

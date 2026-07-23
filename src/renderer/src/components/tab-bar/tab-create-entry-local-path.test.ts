import { afterEach, describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { useAppStore } from '@/store'
import { getTabEntryAllowAbsolutePaths } from './tab-create-entry-local-path'

const initialState = useAppStore.getInitialState()
const localWorktreeId = 'repo-local::/Users/me/repo'

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: '/Users/me/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('getTabEntryAllowAbsolutePaths', () => {
  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('allows absolute paths for a known local worktree', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {
        'repo-local': [
          {
            id: localWorktreeId,
            repoId: 'repo-local',
            path: '/Users/me/repo',
            hostId: 'local'
          } as never
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), localWorktreeId)).toBe(true)
  })

  it('blocks absolute paths when the worktree has an SSH connectionId', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-ssh', connectionId: 'ssh-1' })],
      worktreesByRepo: {
        'repo-ssh': [
          {
            id: 'repo-ssh::/home/neil/repo',
            repoId: 'repo-ssh',
            path: '/home/neil/repo'
          } as never
        ]
      },
      settings: { activeRuntimeEnvironmentId: null } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), 'repo-ssh::/home/neil/repo')).toBe(
      false
    )
  })

  it('blocks absolute paths when activeRuntimeEnvironmentId is set', () => {
    useAppStore.setState({
      repos: [makeRepo({ id: 'repo-local' })],
      worktreesByRepo: {
        'repo-local': [
          {
            id: localWorktreeId,
            repoId: 'repo-local',
            path: '/Users/me/repo',
            hostId: 'runtime:hub-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          } as never
        ]
      },
      runtimeEnvironmentCatalogHydrated: true,
      runtimeEnvironments: [{ id: 'hub-a' }],
      removedRuntimeEnvironmentIds: new Set(),
      settings: { activeRuntimeEnvironmentId: 'hub-a' } as never
    })

    expect(getTabEntryAllowAbsolutePaths(useAppStore.getState(), localWorktreeId)).toBe(false)
  })

  it('blocks absolute paths while worktree connection ownership is unresolved', () => {
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {}
    })

    expect(
      getTabEntryAllowAbsolutePaths(useAppStore.getState(), 'repo-missing::/tmp/repo-feature')
    ).toBe(false)
  })
})

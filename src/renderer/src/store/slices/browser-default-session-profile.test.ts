import { describe, expect, it } from 'vitest'
import {
  resolveDefaultBrowserSessionProfileId,
  type DefaultBrowserSessionProfileState
} from './browser-default-session-profile'

function createState(
  overrides: Partial<DefaultBrowserSessionProfileState> = {}
): DefaultBrowserSessionProfileState {
  return {
    repos: [
      {
        id: 'repo-1',
        path: '/repo-1',
        displayName: 'Repo 1',
        badgeColor: '#000000',
        addedAt: 1,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: {
      'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] as never
    },
    defaultBrowserSessionProfileIdByHostId: {},
    defaultBrowserSessionProfileId: null,
    ...overrides
  }
}

describe('resolveDefaultBrowserSessionProfileId', () => {
  it('prefers the project override over the host and global defaults', () => {
    const state = createState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo-1',
          displayName: 'Repo 1',
          badgeColor: '#000000',
          addedAt: 1,
          executionHostId: 'local',
          defaultBrowserSessionProfileId: 'project-profile'
        }
      ],
      defaultBrowserSessionProfileIdByHostId: { local: 'host-profile' },
      defaultBrowserSessionProfileId: 'global-profile'
    })

    expect(resolveDefaultBrowserSessionProfileId(state, 'wt-1', 'local')).toBe('project-profile')
  })

  it('falls back to the host default when the project has no override', () => {
    const state = createState({
      defaultBrowserSessionProfileIdByHostId: { local: 'host-profile' },
      defaultBrowserSessionProfileId: 'global-profile'
    })

    expect(resolveDefaultBrowserSessionProfileId(state, 'wt-1', 'local')).toBe('host-profile')
  })

  it('falls back to the global default for an unknown workspace', () => {
    const state = createState({ defaultBrowserSessionProfileId: 'global-profile' })

    expect(resolveDefaultBrowserSessionProfileId(state, 'wt-missing', 'local')).toBe(
      'global-profile'
    )
  })

  it('reads the override from the repo row owned by the tab host', () => {
    const state = createState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo-1',
          displayName: 'Repo 1',
          badgeColor: '#000000',
          addedAt: 1,
          executionHostId: 'local',
          defaultBrowserSessionProfileId: 'local-profile'
        },
        {
          id: 'repo-1',
          path: '/repo-1',
          displayName: 'Repo 1',
          badgeColor: '#000000',
          addedAt: 1,
          executionHostId: 'runtime:env-1',
          defaultBrowserSessionProfileId: 'runtime-profile'
        }
      ]
    })

    expect(resolveDefaultBrowserSessionProfileId(state, 'wt-1', 'runtime:env-1')).toBe(
      'runtime-profile'
    )
  })

  it('ignores another host row when the requested host owns none', () => {
    const state = createState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo-1',
          displayName: 'Repo 1',
          badgeColor: '#000000',
          addedAt: 1,
          executionHostId: 'local',
          defaultBrowserSessionProfileId: 'local-only-profile'
        }
      ],
      defaultBrowserSessionProfileId: 'global-profile'
    })

    expect(resolveDefaultBrowserSessionProfileId(state, 'wt-1', 'runtime:env-1')).toBe(
      'global-profile'
    )
  })
})

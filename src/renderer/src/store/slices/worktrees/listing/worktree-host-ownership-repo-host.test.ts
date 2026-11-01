import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { repoHostId } from './worktree-host-ownership'

const focused = { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'env-1' }

describe('repoHostId', () => {
  it('stamps a listing for a repo with no row as this app, never the focused server', () => {
    expect(repoHostId({ repos: [], settings: focused, runtimeEnvironments: [] }, 'repo-1')).toBe(
      'local'
    )
  })

  it('keeps the host the caller names for a repo with no row', () => {
    expect(
      repoHostId({ repos: [], settings: focused, runtimeEnvironments: [] }, 'repo-1', 'ssh:box')
    ).toBe('ssh:box')
  })
})

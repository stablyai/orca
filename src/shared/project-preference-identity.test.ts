import { describe, expect, it } from 'vitest'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'
import {
  projectPreferenceKeyForSetup,
  resolveProjectPreferenceKey
} from './project-preference-identity'
import type { Repo } from './repo-types'

const local: Repo = {
  id: 'same',
  displayName: 'Same',
  path: '/same',
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
}

describe('project preference catalog identity', () => {
  it('separates same-ID folder projects on local, SSH and paired owner hosts', () => {
    const repos: Repo[] = [
      local,
      { ...local, kind: 'folder', connectionId: 'server', executionHostId: 'ssh:server' },
      { ...local, kind: 'folder', executionHostId: 'runtime:server' }
    ]
    const { setups } = projectHostSetupProjectionFromRepos(repos)
    expect(new Set(setups.map(projectPreferenceKeyForSetup)).size).toBe(3)
    expect(resolveProjectPreferenceKey('same', setups)).toBeNull()
    expect(resolveProjectPreferenceKey('same', setups, 'local')).toBe(
      '["local","local","repo:same"]'
    )
    expect(resolveProjectPreferenceKey('same', setups, 'runtime:unknown')).toBeNull()
  })

  it('shares canonical Git identity across setups without matching labels or paths', () => {
    const { setups } = projectHostSetupProjectionFromRepos([local])
    const canonical = setups.map((setup) => ({
      ...setup,
      projectId: 'git:example.org/org/project'
    }))
    const remote = canonical.map((setup) => ({
      ...setup,
      hostId: 'runtime:server' as const,
      path: '/elsewhere',
      displayName: 'Another name'
    }))
    expect(new Set([...canonical, ...remote].map(projectPreferenceKeyForSetup))).toEqual(
      new Set(['git:example.org/org/project'])
    )
  })
})

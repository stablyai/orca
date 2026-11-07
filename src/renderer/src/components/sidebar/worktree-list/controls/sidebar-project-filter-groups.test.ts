import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  addSidebarProjectGroup,
  getSidebarProjectFilterGroups,
  removeSidebarProjectGroup
} from './sidebar-project-filter-groups'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: overrides.id ?? 'repo-1',
    displayName: overrides.displayName ?? 'repo',
    path: overrides.path ?? '/repo',
    kind: 'git',
    addedAt: overrides.addedAt ?? 1,
    badgeColor: overrides.badgeColor ?? '#777777',
    connectionId: overrides.connectionId ?? null,
    executionHostId: overrides.executionHostId,
    upstream: overrides.upstream
  } as Repo
}

describe('sidebar project filter groups', () => {
  it('lists a project checked out on two hosts once and toggles both checkouts', () => {
    const groups = getSidebarProjectFilterGroups([
      repo({ id: 'local', upstream: { owner: 'stablyai', repo: 'orca' } }),
      repo({
        id: 'remote',
        executionHostId: 'runtime:server',
        upstream: { owner: 'stablyai', repo: 'orca' }
      }),
      repo({ id: 'other', upstream: { owner: 'stablyai', repo: 'docs' } })
    ])

    expect(groups).toHaveLength(2)
    const orca = groups.find((group) => group.sources.some((source) => source.id === 'local'))!
    expect(addSidebarProjectGroup(['other'], orca)).toEqual(['other', 'local', 'remote'])
    expect(removeSidebarProjectGroup(['other', 'local', 'remote'], orca)).toEqual(['other'])
  })
})

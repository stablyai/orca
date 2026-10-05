import { describe, expect, it } from 'vitest'
import { resolveProjectGroupEnv, resolveProjectGroupMembers } from './project-group-members'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path' | 'displayName'>): Repo {
  return { badgeColor: '#000000', addedAt: 0, ...overrides }
}

function group(overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id' | 'name'>): ProjectGroup {
  return {
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

const REPOS: Repo[] = [
  repo({
    id: 'r-web',
    path: '/code/web',
    displayName: 'web',
    kind: 'git',
    projectGroupId: 'g-acme'
  }),
  repo({
    id: 'r-notes',
    path: '/notes/acme',
    displayName: 'acme-context',
    kind: 'folder',
    projectGroupId: 'g-acme'
  }),
  repo({
    id: 'r-other',
    path: '/code/unrelated',
    displayName: 'unrelated',
    kind: 'git',
    projectGroupId: 'g-other'
  }),
  repo({ id: 'r-loose', path: '/code/loose', displayName: 'loose', kind: 'git' })
]

const GROUPS: ProjectGroup[] = [group({ id: 'g-acme', name: 'Acme' })]

describe('resolveProjectGroupMembers', () => {
  it('returns only the projects in the group, name-sorted', () => {
    expect(resolveProjectGroupMembers('g-acme', REPOS)).toEqual([
      { id: 'r-notes', name: 'acme-context', path: '/notes/acme', kind: 'folder' },
      { id: 'r-web', name: 'web', path: '/code/web', kind: 'git' }
    ])
  })

  it('defaults a missing kind to git', () => {
    const members = resolveProjectGroupMembers('g-acme', [
      repo({ id: 'r-x', path: '/code/x', displayName: 'x', projectGroupId: 'g-acme' })
    ])
    expect(members[0]?.kind).toBe('git')
  })

  it('is stable when two projects share a display name', () => {
    const shared = [
      repo({ id: 'r-b', path: '/b', displayName: 'same', projectGroupId: 'g-acme' }),
      repo({ id: 'r-a', path: '/a', displayName: 'same', projectGroupId: 'g-acme' })
    ]
    expect(resolveProjectGroupMembers('g-acme', shared).map((member) => member.id)).toEqual([
      'r-a',
      'r-b'
    ])
  })
})

describe('resolveProjectGroupEnv', () => {
  it('exposes the group and its sibling projects', () => {
    const env = resolveProjectGroupEnv('g-acme', REPOS, GROUPS)
    expect(env.ORCA_PROJECT_GROUP_ID).toBe('g-acme')
    expect(env.ORCA_PROJECT_GROUP_NAME).toBe('Acme')
    expect(JSON.parse(env.ORCA_PROJECT_GROUP_PROJECTS ?? '[]')).toEqual([
      { id: 'r-notes', name: 'acme-context', path: '/notes/acme', kind: 'folder' },
      { id: 'r-web', name: 'web', path: '/code/web', kind: 'git' }
    ])
  })

  it('stays empty for an ungrouped workspace so the env is untouched', () => {
    expect(resolveProjectGroupEnv(null, REPOS, GROUPS)).toEqual({})
    expect(resolveProjectGroupEnv(undefined, REPOS, GROUPS)).toEqual({})
  })

  it('stays empty when the group id has no matching group', () => {
    expect(resolveProjectGroupEnv('g-missing', REPOS, GROUPS)).toEqual({})
  })
})

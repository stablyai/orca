import { expect, it } from 'vitest'
import { resolveProjectHostSetupProjection } from './project-catalog-canonical-projection'
import { projectHostSetupProjectionFromRepos } from './project-host-setup-projection'
import { adoptEndpointProjectCatalog, adoptEndpointRepo } from './endpoint-catalog-adoption'
import type { Repo } from './repo-types'

it('retains nested SSH execution ownership without duplicating derived fallback setups', () => {
  const endpoint = { kind: 'environment', environmentId: 'server' } as const
  const native: Repo[] = ['one', 'two'].map((connectionId) => ({
    id: 'same',
    path: `/${connectionId}/app`,
    connectionId,
    displayName: connectionId,
    addedAt: 1,
    badgeColor: '',
    upstream: { owner: 'acme', repo: 'app' }
  }))
  const nativeProjection = projectHostSetupProjectionFromRepos(native)
  const raw = adoptEndpointProjectCatalog(
    endpoint,
    nativeProjection.projects.map((project) => ({ ...project, id: 'repo:legacy' })),
    nativeProjection.setups.map((setup) => ({ ...setup, projectId: 'repo:legacy' }))
  )
  const repos = native.map((repo) => adoptEndpointRepo(endpoint, repo))
  const canonical = resolveProjectHostSetupProjection(repos, raw.projects, raw.setups)
  expect(canonical.setups).toHaveLength(2)
  expect(
    canonical.setups.map((setup) => [setup.hostId, setup.executionHostId, setup.projectId])
  ).toEqual([
    ['runtime:server', 'ssh:one', 'github:acme/app'],
    ['runtime:server', 'ssh:two', 'github:acme/app']
  ])
  expect(raw.setups.every((setup) => setup.projectId === 'repo:legacy')).toBe(true)
})

it('preserves unresolved legacy project rows during a partial repo-only catalog hydrate', () => {
  const repo: Repo = { id: 'a', path: '/a', displayName: 'A', addedAt: 1, badgeColor: '' }
  const legacy = {
    id: 'legacy',
    displayName: 'Legacy',
    sourceRepoIds: ['not-loaded'],
    createdAt: 1,
    updatedAt: 1,
    badgeColor: ''
  }
  expect(resolveProjectHostSetupProjection([repo], [legacy], []).projects).toContainEqual(legacy)
})

it('qualifies provisioned setup facts by nested execution owner while claims retain repo addedAt', () => {
  const endpoint = { kind: 'environment', environmentId: 'server' } as const
  const native: Repo[] = [
    { id: 'same', connectionId: 'one', path: '/one/copy', addedAt: 1 },
    { id: 'same', connectionId: 'two', path: '/two/user', addedAt: 1 },
    { id: 'user', connectionId: 'one', path: '/one/user', addedAt: 2 },
    { id: 'later', connectionId: 'one', path: '/one/later', addedAt: 3 }
  ].map((repo) => ({
    ...repo,
    displayName: repo.id,
    badgeColor: '',
    upstream: { owner: 'acme', repo: 'app' }
  }))
  const projection = projectHostSetupProjectionFromRepos(native)
  const raw = adoptEndpointProjectCatalog(
    endpoint,
    [
      { ...projection.projects[0], id: 'github:acme/app', sourceRepoIds: ['same', 'user', 'later'] }
    ],
    projection.setups.map((setup) => ({
      ...setup,
      projectId: 'github:acme/app',
      setupMethod:
        setup.repoId === 'same' && setup.connectionId === 'one'
          ? 'provisioned'
          : 'imported-existing-folder',
      createdAt: setup.repoId === 'later' ? 0 : 99
    }))
  )
  const canonical = resolveProjectHostSetupProjection(
    native.map((repo) => adoptEndpointRepo(endpoint, repo)),
    raw.projects,
    raw.setups
  )
  expect(canonical.setups.find((setup) => setup.repoId === 'user')?.projectId).toBe(
    'github:acme/app'
  )
  expect(canonical.setups.find((setup) => setup.repoId === 'later')?.projectId).toBe('repo:later')
  expect(
    canonical.setups.find((setup) => setup.repoId === 'same' && setup.executionHostId === 'ssh:one')
      ?.setupMethod
  ).toBe('provisioned')
})

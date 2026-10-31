import { describe, expect, it } from 'vitest'
import type { Project } from '../../../shared/project-types'
import type { Repo } from '../../../shared/repo-types'
import { resolveProjectCloneUrlPrefill } from './project-clone-url-prefill'

function project(sourceRepoIds: string[]): Project {
  return { id: 'project-orca', sourceRepoIds } as unknown as Project
}

function repo(id: string, remoteUrl: string): Repo {
  return { id, gitRemoteIdentity: { remoteUrl } } as unknown as Repo
}

describe('resolveProjectCloneUrlPrefill', () => {
  it('strips an embedded token so it is never cloned onto another host', () => {
    // The clone runs on the target host and would persist this into .git/config.
    const prefill = resolveProjectCloneUrlPrefill(
      [project(['repo-1'])],
      [repo('repo-1', 'https://x-access-token:ghp_ABC123@github.com/acme/orca.git')],
      'project-orca'
    )

    expect(prefill).toBe('https://github.com/acme/orca.git')
    expect(prefill).not.toContain('ghp_ABC123')
  })

  it('leaves an SSH remote untouched, since git@host is part of the URL', () => {
    expect(
      resolveProjectCloneUrlPrefill(
        [project(['repo-1'])],
        [repo('repo-1', 'git@github.com:stablyai/orca.git')],
        'project-orca'
      )
    ).toBe('git@github.com:stablyai/orca.git')
  })
  it('stops on the first usable source and indexes later misses only once', () => {
    let reads = 0
    const repos = Array.from({ length: 1000 }, (_, i) => ({
      ...repo(`repo-${i}`, 'https://gitlab.com/acme/repo.git'),
      get id() {
        reads++
        return `repo-${i}`
      }
    }))
    const sourceIds = Array.from({ length: 1000 }, (_, i) => `repo-${i}`)
    expect(resolveProjectCloneUrlPrefill([project(sourceIds)], repos, 'project-orca')).toBe(
      'https://gitlab.com/acme/repo.git'
    )
    expect(reads).toBe(1)
    reads = 0
    expect(
      resolveProjectCloneUrlPrefill(
        [project(sourceIds.map((id) => `missing-${id}`))],
        repos,
        'project-orca'
      )
    ).toBe('')
    expect(reads).toBeLessThanOrEqual(2000)
  })

  it('keeps the first duplicate repo authoritative when building the fallback index', () => {
    expect(
      resolveProjectCloneUrlPrefill(
        [project(['missing', 'duplicate'])],
        [repo('duplicate', ''), repo('duplicate', 'https://gitlab.com/acme/repo.git')],
        'project-orca'
      )
    ).toBe('')
  })
})

it.each([
  [100, 100, 100],
  [1000, 100, 100],
  [100, 1000, 100],
  [100, 100, 1000],
  [1000, 1000, 1000]
])('bounds concrete raw membership independently at P=%i R=%i S=%i', (p, r, s) => {
  let projectReads = 0
  let repoReads = 0
  let memberReads = 0
  const ids = Array.from({ length: s }, (_, i) => `member-${i}`)
  ids[s - 1] = 'source'
  for (let i = 0; i < s; i++) {
    const value = ids[i]
    Object.defineProperty(ids, i, {
      get: () => {
        memberReads++
        return value
      }
    })
  }
  const projects = Array.from({ length: p }, (_, i) => ({
    ...project(i === p - 1 ? ids : []),
    get id() {
      projectReads++
      return i === p - 1 ? 'project-group:folder' : `p-${i}`
    }
  }))
  const repos = Array.from({ length: r }, (_, i) => ({
    ...repo(i === r - 1 ? 'source' : `r-${i}`, 'https://token:private@github.com/org/app.git'),
    get id() {
      repoReads++
      return i === r - 1 ? 'source' : `r-${i}`
    },
    path: `/r-${i}`,
    executionHostId: 'runtime:server' as const
  }))
  const source = { repoId: 'source', hostId: 'runtime:server', path: `/r-${r - 1}` }
  expect(
    resolveProjectCloneUrlPrefill(
      projects,
      repos,
      'project-group:folder',
      undefined,
      undefined,
      source
    )
  ).toBe('https://github.com/org/app.git')
  expect(projectReads).toBe(p)
  expect(repoReads).toBeLessThanOrEqual(r + 1)
  expect(memberReads).toBe(s)
  projectReads = repoReads = memberReads = 0
  expect(
    resolveProjectCloneUrlPrefill(
      projects,
      repos,
      'project-group:missing',
      undefined,
      undefined,
      source
    )
  ).toBe('')
  expect(projectReads).toBe(p)
  expect(repoReads).toBe(r)
  expect(memberReads).toBe(0)
})

it('keeps first raw Project/Repo, namespace, exact source and blank/manual authority', () => {
  const current = {
    ...repo('source', 'https://github.com/owner/app.git'),
    path: '/second',
    executionHostId: 'runtime:server' as const
  }
  const projects = [{ ...project(['source']), id: 'project-group:folder' }]
  const resolve = (
    repos: Repo[],
    source: { repoId: string; hostId: string; path?: string | null },
    rows = projects
  ) =>
    resolveProjectCloneUrlPrefill(rows, repos, 'project-group:folder', undefined, undefined, source)
  const source = { repoId: 'source', hostId: 'runtime:server', path: '/second' }
  expect(resolve([current], source)).toBe('https://github.com/owner/app.git')
  for (const path of [undefined, null, '']) {
    expect(resolve([current], { ...source, path })).toBe('https://github.com/owner/app.git')
  }
  expect(resolve([current], { ...source, path: '/missing' })).toBe('')
  expect(resolve([current], { ...source, hostId: 'local' })).toBe('')
  expect(resolve([current], { ...source, repoId: 'missing' })).toBe('')
  expect(resolve([{ ...current, gitRemoteIdentity: undefined }], source)).toBe('')
  expect(resolve([{ ...current, gitRemoteIdentity: undefined }, current], source)).toBe('')
  expect(resolve([current], source, [{ ...projects[0], sourceRepoIds: [] }, ...projects])).toBe('')
  expect(resolve([current], source, [])).toBe('')
})

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

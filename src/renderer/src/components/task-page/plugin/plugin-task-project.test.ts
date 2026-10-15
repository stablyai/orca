import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { findRepoIdForProjectPath, resolvePluginTaskProject } from './plugin-task-project'

const pathRepos = [
  { id: 'remote', path: '/home/me/Work', connectionId: 'ssh-1' },
  { id: 'local', path: '/home/me/Work/', connectionId: null }
]

describe('findRepoIdForProjectPath', () => {
  it('matches across a trailing separator, preferring local projects', () => {
    expect(findRepoIdForProjectPath(pathRepos, '/home/me/Work')).toBe('local')
  })

  it('keeps POSIX paths case-sensitive', () => {
    expect(findRepoIdForProjectPath(pathRepos, '/home/me/work')).toBeNull()
  })
})

function project(id: string, path: string, canonicalKey: string): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    gitRemoteIdentity: { canonicalKey, remoteName: 'origin', remoteUrl: `https://${canonicalKey}` }
  }
}

const repos = [
  project('active', '/work/active', 'github.com/acme/active'),
  project('app', '/work/app', 'github.com/acme/app')
]

describe('resolvePluginTaskProject', () => {
  it('uses the named folder, and reports a folder that is not a project', async () => {
    await expect(
      resolvePluginTaskProject({ projectPath: '/work/app/' }, repos, 'active')
    ).resolves.toEqual({ kind: 'found', repoId: 'app' })
    await expect(
      resolvePluginTaskProject({ projectPath: '/work/gone' }, repos, 'active')
    ).resolves.toMatchObject({ kind: 'missing', message: expect.stringContaining('/work/gone') })
  })

  it('picks the project by its source, and never falls back to the active one', async () => {
    await expect(
      resolvePluginTaskProject({ projectSource: 'git@github.com:acme/app.git' }, repos, 'active')
    ).resolves.toEqual({ kind: 'found', repoId: 'app' })
    await expect(
      resolvePluginTaskProject({ projectSource: 'https://github.com/acme/gone' }, repos, 'active')
    ).resolves.toMatchObject({ kind: 'missing' })
  })

  it('leaves the composer default when the recipe names no project', async () => {
    await expect(
      resolvePluginTaskProject({ baseRef: 'origin/main' }, repos, 'active')
    ).resolves.toEqual({ kind: 'unspecified' })
  })
})

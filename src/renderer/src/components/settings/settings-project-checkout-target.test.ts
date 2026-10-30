import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList,
  getSettingsProjectHostRepo
} from './settings-project-list'

function makeCheckouts(paths: readonly string[]): Repo[] {
  return paths.map((path, index) => ({
    id: `checkout-${index + 1}`,
    path,
    displayName: `app-${index + 1}`,
    badgeColor: '',
    addedAt: index,
    gitRemoteIdentity: {
      canonicalKey: 'gitlab.com/acme/app',
      remoteName: 'origin',
      remoteUrl: 'https://gitlab.com/acme/app.git'
    }
  }))
}

describe('local Project Settings checkout targets', () => {
  it.each([
    ['Windows', ['C:\\projects\\develop', 'C:\\projects\\rc', 'C:\\projects\\patch']],
    ['Linux', ['/projects/develop', '/projects/rc', '/projects/patch']],
    ['macOS', ['/Users/fixture/develop', '/Users/fixture/rc', '/Users/fixture/patch']],
    [
      'WSL',
      [
        '\\\\wsl$\\Ubuntu\\home\\fixture\\develop',
        '\\\\wsl$\\Ubuntu\\home\\fixture\\rc',
        '\\\\wsl$\\Ubuntu\\home\\fixture\\patch'
      ]
    ]
  ] as const)('opens each same-origin checkout with %s paths', (_platform, paths) => {
    const repos = makeCheckouts(paths)
    const projects = buildSettingsProjectList(repos)
    const representatives = buildRepoIdToRepresentative(projects)
    const selections = buildRepoIdToHostSelection(projects)

    for (const repo of repos) {
      const representative = representatives.get(repo.id)
      expect(representative).toBe(repo.id)
      const entry = projects.find((project) => project.representativeRepoId === representative)
      expect(entry).toBeDefined()
      if (!entry) {
        throw new Error(`No settings entry for ${repo.id}`)
      }
      const selection = selections.get(repo.id)
      expect(getSettingsProjectHostRepo(entry, repos, selection?.hostId)?.id).toBe(repo.id)
    }
  })

  it('keeps independent folder projects reachable', () => {
    const repos: Repo[] = makeCheckouts(['/folders/first', '/folders/second']).map((repo) => ({
      ...repo,
      kind: 'folder',
      gitRemoteIdentity: null
    }))
    const projects = buildSettingsProjectList(repos)
    const representatives = buildRepoIdToRepresentative(projects)
    expect(projects).toHaveLength(2)
    for (const repo of repos) {
      expect(representatives.get(repo.id)).toBe(repo.id)
    }
  })
})

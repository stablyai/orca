import { describe, expect, it } from 'vitest'
import { searchCmdJProjectResults } from './palette-project-results'
import type { Repo } from '../../../../shared/repo-types'

function makeRepo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'displayName'>): Repo {
  return { path: `/work/${overrides.displayName}`, badgeColor: '#22c55e', addedAt: 0, ...overrides }
}

// The project is shown as "Registry"; its remote is lab-team/vault-registry.
const registry = makeRepo({
  id: 'repo-registry',
  displayName: 'Registry',
  gitRemoteIdentity: {
    canonicalKey: 'github.com/lab-team/vault-registry',
    remoteName: 'origin',
    remoteUrl: 'git@github.com:lab-team/vault-registry.git'
  }
})
const scratch = makeRepo({ id: 'repo-scratch', displayName: 'scratch' })

function search(query: string): { title: string; remoteName: string | null }[] {
  return searchCmdJProjectResults({
    query,
    projectGroups: [],
    repos: [registry, scratch],
    projects: [],
    projectHostSetups: []
  }).map((result) => ({
    title: result.title,
    remoteName: result.kind === 'project' ? result.remoteName : null
  }))
}

describe('project palette search by remote repository name', () => {
  it('finds a project by the repository name it is not displayed under', () => {
    expect(search('vault-registry')).toEqual([
      { title: 'Registry', remoteName: 'lab-team/vault-registry' }
    ])
  })

  it('finds a project by its owner', () => {
    expect(search('lab-team').map((result) => result.title)).toEqual(['Registry'])
  })

  it('carries the repository name for a project found by its displayed name', () => {
    expect(search('Registry')).toEqual([
      { title: 'Registry', remoteName: 'lab-team/vault-registry' }
    ])
  })

  it('carries no repository name for a project with no remote', () => {
    expect(search('scratch')).toEqual([{ title: 'scratch', remoteName: '' }])
  })
})

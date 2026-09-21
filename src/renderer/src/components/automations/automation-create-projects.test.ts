import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getAutomationCreateRepos } from './automation-create-projects'

function repo(id: string, executionHostId: Repo['executionHostId']): Repo {
  return {
    id,
    path: `/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 1,
    executionHostId
  }
}

describe('getAutomationCreateRepos', () => {
  const repos = [
    repo('local', 'local'),
    repo('remote', 'runtime:env-1'),
    repo('ssh', 'ssh:builder')
  ]

  it('selects only the destination runtime catalog', () => {
    expect(
      getAutomationCreateRepos(repos, { kind: 'environment', environmentId: 'env-1' })
    ).toEqual([repos[1]])
  })

  it('keeps local and direct SSH rows but excludes paired-runtime rows', () => {
    expect(getAutomationCreateRepos(repos, { kind: 'local' })).toEqual([repos[0], repos[2]])
  })

  it('fails closed when the destination runtime has no project', () => {
    expect(
      getAutomationCreateRepos(repos, { kind: 'environment', environmentId: 'missing' })
    ).toEqual([])
  })
})

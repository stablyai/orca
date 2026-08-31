import { describe, expect, it } from 'vitest'
import { buildGitLabProviderIdentity, getTaskPageRepoCacheInput } from './repo-source-context'
import type { Repo } from '../../../../../shared/repo-types'

describe('buildGitLabProviderIdentity', () => {
  it('splits namespace and project and builds the web URL', () => {
    expect(
      buildGitLabProviderIdentity({
        host: 'gitlab.example.com',
        path: 'acme/platform/orca'
      })
    ).toEqual({
      provider: 'gitlab',
      projectId: 'acme/platform/orca',
      namespace: 'acme/platform',
      project: 'orca',
      webUrl: 'https://gitlab.example.com/acme/platform/orca'
    })
  })

  it('treats a single path segment as the project with no namespace', () => {
    expect(
      buildGitLabProviderIdentity({
        host: 'gitlab.com',
        path: 'solo'
      })
    ).toEqual({
      provider: 'gitlab',
      projectId: 'solo',
      namespace: null,
      project: 'solo',
      webUrl: 'https://gitlab.com/solo'
    })
  })
})

describe('getTaskPageRepoCacheInput', () => {
  it('copies repo identity fields used by the GitHub work-item cache', () => {
    const repo = {
      id: 'repo-1',
      path: '/tmp/orca',
      executionHostId: 'local'
    } as Repo
    const input = getTaskPageRepoCacheInput(repo)
    expect(input.id).toBe('repo-1')
    expect(input.path).toBe('/tmp/orca')
    expect(input.executionHostId).toBe('local')
  })
})

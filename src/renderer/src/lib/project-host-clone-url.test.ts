import { describe, expect, it } from 'vitest'
import type { Project } from '../../../shared/types'
import { getProjectHostCloneUrl } from './project-host-clone-url'

function createProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#000',
    sourceRepoIds: ['repo-1'],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('getProjectHostCloneUrl', () => {
  it('builds a GitHub HTTPS clone URL from provider identity', () => {
    expect(
      getProjectHostCloneUrl(
        createProject({
          providerIdentity: {
            provider: 'github',
            owner: ' stablyai ',
            repo: ' orca '
          }
        })
      )
    ).toBe('https://github.com/stablyai/orca.git')
  })

  it('returns null when provider identity is missing or incomplete', () => {
    expect(getProjectHostCloneUrl(createProject())).toBeNull()
    expect(
      getProjectHostCloneUrl(
        createProject({
          providerIdentity: {
            provider: 'github',
            owner: '',
            repo: 'orca'
          }
        })
      )
    ).toBeNull()
  })
})

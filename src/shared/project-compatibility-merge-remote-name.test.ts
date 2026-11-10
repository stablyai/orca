import { describe, expect, it } from 'vitest'
import type { Project } from './project-types'
import type { Repo } from './repo-types'
import { mergePreviousProjectMetadata } from './project-compatibility-merge'

const localRepo = { id: 'local-repo', path: '/Users/me/orca-sandbox-push-test' } as Repo
const vmRepo = {
  id: 'vm-repo',
  path: '/vercel/sandbox/project',
  executionHostId: 'runtime:env-1'
} as Repo

function project(displayName: string, sourceRepoIds: string[]): Project {
  return {
    id: 'github:acme/orca-sandbox-push-test',
    displayName,
    sourceRepoIds,
    badgeColor: '#888888',
    createdAt: 1,
    updatedAt: 1
  } as Project
}

const reposById = new Map<string, readonly Repo[]>([
  ['local-repo', [localRepo]],
  ['vm-repo', [vmRepo]]
])

describe('mergePreviousProjectMetadata project names', () => {
  it('a sandbox refresh does not rename a project this computer has to its checkout folder', () => {
    const merged = mergePreviousProjectMetadata(
      project('orca-sandbox-push-test', ['local-repo']),
      project('project', ['vm-repo']),
      reposById,
      'runtime:env-1'
    )
    expect(merged.displayName).toBe('orca-sandbox-push-test')
  })

  it('a local refresh still applies a rename', () => {
    const merged = mergePreviousProjectMetadata(
      project('orca-sandbox-push-test', ['local-repo']),
      project('Renamed', ['local-repo']),
      reposById,
      'local'
    )
    expect(merged.displayName).toBe('Renamed')
  })
})

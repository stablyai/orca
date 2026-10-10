import { describe, expect, it } from 'vitest'
import type { ProjectHostSetup } from './project-types'
import { findProjectHostSetup, getProjectHostSetupForRepo } from './project-host-setup-lookup'
import {
  ProjectHostSetupDelete,
  ProjectHostSetupUpdate
} from './rpc-contract/project-runtime-params'
import type { Repo } from './repo-types'

function setup(hostId: ProjectHostSetup['hostId']): ProjectHostSetup {
  return {
    id: 'same-id',
    projectId: 'project',
    hostId,
    repoId: 'same-id',
    path: '/repo',
    displayName: hostId,
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1
  }
}
function repo(hostId: ProjectHostSetup['hostId']): Repo {
  return {
    id: 'same-id',
    path: '/repo',
    displayName: hostId,
    executionHostId: hostId,
    badgeColor: '#000',
    addedAt: 1,
    kind: 'folder'
  }
}

describe('project setup authoritative identity without ID migration', () => {
  it('preserves exact legacy runtime stamps at both mutation boundaries', () => {
    for (const schema of [ProjectHostSetupDelete]) {
      expect(
        schema.parse({ setupId: 'same-id', executionHostId: 'runtime:legacy-client' })
          .executionHostId
      ).toBe('runtime:legacy-client')
      expect(() => schema.parse({ setupId: 'same-id', executionHostId: 'invalid' })).toThrow()
      expect(() => schema.parse({ setupId: 'same-id', executionHostId: null })).toThrow()
    }
    expect(
      ProjectHostSetupUpdate.parse({
        setupId: 'same-id',
        executionHostId: 'runtime:legacy-client',
        updates: {}
      }).executionHostId
    ).toBe('runtime:legacy-client')
  })
  it('refuses duplicate exact owners and preserves unique legacy lookup', () => {
    expect(findProjectHostSetup([setup('local')], { setupId: 'same-id' })?.hostId).toBe('local')
    expect(() =>
      findProjectHostSetup([setup('local'), setup('local')], {
        setupId: 'same-id',
        executionHostId: 'local'
      })
    ).toThrow(/ambiguous/)
    expect(
      findProjectHostSetup([setup('local')], { setupId: 'same-id', executionHostId: 'ssh:missing' })
    ).toBeUndefined()
  })
  it('derives missing repo ownership instead of borrowing a sibling setup', () => {
    expect(getProjectHostSetupForRepo([setup('local')], repo('ssh:target')).hostId).toBe(
      'ssh:target'
    )
  })
})

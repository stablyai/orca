import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { resolveComposerActiveRepoId } from './new-workspace-composer-repo'

function repo(id: string, executionHostId: ExecutionHostId, path: string): Repo {
  return {
    id,
    path,
    displayName: 'app',
    badgeColor: '#000000',
    addedAt: 0,
    executionHostId,
    connectionId: null,
    gitRemoteIdentity: {
      canonicalKey: 'github.com/acme/app',
      remoteName: 'origin',
      remoteUrl: 'git@github.com:acme/app.git'
    }
  }
}

describe('resolveComposerActiveRepoId', () => {
  it('seeds from the visible checkout when the active workspace is on a per-workspace VM', () => {
    const vmRepo = repo('vm-repo', 'runtime:vm-1', '/home/orca/app')
    const macRepo = repo('mac-repo', 'local', '/Users/me/app')
    const repos = [vmRepo, macRepo]

    expect(
      resolveComposerActiveRepoId(repos, repos, 'vm-repo', [{ id: 'vm-1', source: 'ephemeral-vm' }])
    ).toBe('mac-repo')
  })
})

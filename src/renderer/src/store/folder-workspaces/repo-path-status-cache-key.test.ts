import { describe, expect, it } from 'vitest'
import { getFolderWorkspacePathStatusScopeKey } from './folder-workspace-routing'

describe('repo path status cache keys', () => {
  it('fences the same repo path to its execution host', () => {
    const local = getFolderWorkspacePathStatusScopeKey({
      scope: 'repo',
      repoId: 'repo-1',
      executionHostId: 'local'
    } as never)
    const ssh = getFolderWorkspacePathStatusScopeKey({
      scope: 'repo',
      repoId: 'repo-1',
      executionHostId: 'ssh:builder'
    } as never)

    expect(local).not.toBe(ssh)
  })
})

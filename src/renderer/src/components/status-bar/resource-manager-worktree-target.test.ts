import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { resolveResourceManagerWorktreeTarget } from './resource-manager-worktree-target'

const LOCAL = 'local' as ExecutionHostId
const SSH = 'ssh:box' as ExecutionHostId

describe('resolveResourceManagerWorktreeTarget', () => {
  it('preserves the unique row host for a routed action', () => {
    expect(
      resolveResourceManagerWorktreeTarget('repo::path', [
        { id: 'other::path', hostId: LOCAL },
        { id: 'repo::path', hostId: SSH }
      ])
    ).toEqual({ id: 'repo::path', hostId: SSH })
  })

  it('fails closed when the resource row represents workspaces on multiple hosts', () => {
    expect(
      resolveResourceManagerWorktreeTarget('repo::path', [
        { id: 'repo::path', hostId: LOCAL },
        { id: 'repo::path', hostId: SSH }
      ])
    ).toBeNull()
  })
})

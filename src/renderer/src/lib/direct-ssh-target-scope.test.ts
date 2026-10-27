import { describe, expect, it } from 'vitest'
import {
  resolveDirectSshTargetWorktreeIds,
  type DirectSshTargetScopeInput
} from './direct-ssh-target-scope'

const baseInput: DirectSshTargetScopeInput = {
  targetId: 'target-a',
  repos: []
}

describe('resolveDirectSshTargetWorktreeIds', () => {
  it('resolves duplicate repo IDs by exact SSH host instead of first wins', () => {
    const worktreeIds = resolveDirectSshTargetWorktreeIds({
      ...baseInput,
      repos: [
        {
          id: 'shared',
          path: '/local/shared',
          projectGroupId: null,
          connectionId: null,
          executionHostId: 'local'
        },
        {
          id: 'shared',
          path: '/remote/shared',
          projectGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      worktreesByRepo: {
        shared: [{ id: 'shared::remote', repoId: 'shared', hostId: 'ssh:target-a' }]
      }
    })

    expect(worktreeIds).toEqual(new Set(['shared::remote']))
  })

  it('keeps duplicate same-host repo owners ambiguous', () => {
    const duplicate = {
      id: 'duplicate',
      path: '/remote/duplicate',
      projectGroupId: null,
      connectionId: 'target-a',
      executionHostId: 'ssh:target-a' as const
    }
    const worktreeIds = resolveDirectSshTargetWorktreeIds({
      ...baseInput,
      repos: [duplicate, { ...duplicate }],
      worktreesByRepo: {
        duplicate: [{ id: 'duplicate::worktree', repoId: 'duplicate', hostId: 'ssh:target-a' }]
      }
    })

    expect(worktreeIds.size).toBe(0)
  })

  it('keeps runtime-owned SSH work isolated from the direct target', () => {
    const worktreeIds = resolveDirectSshTargetWorktreeIds({
      ...baseInput,
      repos: [
        {
          id: 'runtime-ssh',
          path: '/runtime/repo',
          projectGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      worktreesByRepo: {
        'runtime-ssh': [
          {
            id: 'runtime-ssh::worktree',
            repoId: 'runtime-ssh',
            hostId: 'ssh:target-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          }
        ]
      }
    })

    expect(worktreeIds.size).toBe(0)
  })

  it('rejects explicit worktree and exact repo ownership contradictions', () => {
    const worktreeIds = resolveDirectSshTargetWorktreeIds({
      ...baseInput,
      repos: [
        {
          id: 'repo',
          path: '/target-a/repo',
          projectGroupId: null,
          connectionId: 'target-a',
          executionHostId: 'ssh:target-a'
        }
      ],
      worktreesByRepo: {
        repo: [{ id: 'repo::wrong-host', repoId: 'repo', hostId: 'ssh:target-b' }]
      }
    })

    expect(worktreeIds.size).toBe(0)
  })

  it('excludes legacy rows with no owner and unresolved runtime owners', () => {
    const worktreeIds = resolveDirectSshTargetWorktreeIds({
      ...baseInput,
      worktreesByRepo: {
        legacy: [{ id: 'legacy::worktree', repoId: 'legacy' }],
        unresolved: [
          { id: 'unresolved::worktree', repoId: 'unresolved', hostId: 'runtime:unresolved-owner' }
        ]
      }
    })

    expect(worktreeIds.size).toBe(0)
  })
})

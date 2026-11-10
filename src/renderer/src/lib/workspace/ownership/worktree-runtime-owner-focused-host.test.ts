import { describe, expect, it } from 'vitest'
import { getExecutionHostIdForWorktree } from './worktree-runtime-owner'
import { runtimeEnvironmentIdForWorkspaceOwner } from './resolve-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

function ownerEnvironmentId(state: WorktreeRuntimeOwnerState, workspaceId: string): string | null {
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId })
  return owner.kind === 'resolved' ? owner.environmentId : null
}

describe('focused host among conflicting detected owners', () => {
  it('prefers the focused HUB for conflicting detected-only ownership (#10491)', () => {
    const ambiguousState: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'hub-a' },
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {
        'repo-a': {
          worktrees: [
            {
              id: 'shared-worktree',
              repoId: 'repo-a',
              hostId: 'ssh:private-a',
              runtimeOwnerEnvironmentId: 'hub-a'
            }
          ]
        },
        'repo-b': {
          worktrees: [
            {
              id: 'shared-worktree',
              repoId: 'repo-b',
              hostId: 'ssh:private-b',
              runtimeOwnerEnvironmentId: 'hub-b'
            }
          ]
        }
      }
    }

    expect(ownerEnvironmentId(ambiguousState, 'shared-worktree')).toBe('hub-a')
    expect(getExecutionHostIdForWorktree(ambiguousState, 'shared-worktree')).toBe('ssh:private-a')
  })

  it('fails closed for conflicting detected-only ownership when focus matches neither', () => {
    const ambiguousState: WorktreeRuntimeOwnerState = {
      settings: { activeRuntimeEnvironmentId: 'hub-c' },
      repos: [],
      worktreesByRepo: {},
      detectedWorktreesByRepo: {
        'repo-a': {
          worktrees: [
            {
              id: 'shared-worktree',
              repoId: 'repo-a',
              hostId: 'ssh:private-a',
              runtimeOwnerEnvironmentId: 'hub-a'
            }
          ]
        },
        'repo-b': {
          worktrees: [
            {
              id: 'shared-worktree',
              repoId: 'repo-b',
              hostId: 'ssh:private-b',
              runtimeOwnerEnvironmentId: 'hub-b'
            }
          ]
        }
      }
    }

    expect(ownerEnvironmentId(ambiguousState, 'shared-worktree')).toBeNull()
    expect(getExecutionHostIdForWorktree(ambiguousState, 'shared-worktree')).toBe(
      'runtime:unresolved-owner'
    )
  })
})

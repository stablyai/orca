import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { createSetWorktreesPinnedAndReveal } from './worktree-pin-reveal'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/feature',
    repoId: 'repo',
    displayName: 'Feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    path: '/feature',
    head: 'head',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function sliceState(
  worktrees: Worktree[],
  overrides: Partial<{
    activeWorktreeId: string | null
    activeWorkspaceExecutionHostId: ExecutionHostId | null
    settings: { showPinnedWorktreesInGroups: boolean }
  }> = {}
) {
  const activeWorkspaceExecutionHostId: ExecutionHostId | null = null
  const state = {
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId,
    activeWorkspaceKey: null,
    worktreeLineageById: {},
    settings: { showPinnedWorktreesInGroups: true },
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    getKnownWorktreeById: (worktreeId: string, executionHostId?: string) =>
      worktrees.find(
        (candidate) =>
          candidate.id === worktreeId &&
          (executionHostId === undefined || (candidate.hostId ?? 'local') === executionHostId)
      ),
    ...overrides
  }
  return { state, get: () => state }
}

function withLineage(
  worktree: Worktree,
  lineage: WorktreeLineage
): Worktree & { lineage: WorktreeLineage } {
  return { ...worktree, lineage }
}

describe('setWorktreesPinnedAndReveal', () => {
  it('writes to the host named by a qualified target, not the first id match', () => {
    const local = worktree({ hostId: 'local' })
    const remote = worktree({ hostId: 'ssh:build' })
    const { state, get } = sliceState([local, remote])

    createSetWorktreesPinnedAndReveal(get)(
      [{ worktreeId: remote.id, executionHostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      {
        worktreeId: remote.id,
        updates: { isPinned: true },
        executionHostId: 'ssh:build'
      }
    ])
    expect(state.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not reveal a local lineage child when a remote twin ancestor changed', () => {
    const localParent = worktree({
      id: 'repo::/parent',
      hostId: 'local',
      instanceId: 'local-parent'
    })
    const remoteParent = worktree({
      id: 'repo::/parent',
      hostId: 'ssh:host-b',
      instanceId: 'remote-parent'
    })
    const localChild = withLineage(
      worktree({ id: 'repo::/child', hostId: 'local', instanceId: 'local-child' }),
      {
        worktreeId: 'repo::/child',
        worktreeInstanceId: 'local-child',
        parentWorktreeId: 'repo::/parent',
        parentWorktreeInstanceId: 'local-parent',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    )
    const remoteChild = withLineage(
      worktree({ id: 'repo::/child', hostId: 'ssh:host-b', instanceId: 'remote-child' }),
      {
        worktreeId: 'repo::/child',
        worktreeInstanceId: 'remote-child',
        parentWorktreeId: 'repo::/parent',
        parentWorktreeInstanceId: 'remote-parent',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      }
    )
    const { state, get } = sliceState([localParent, remoteParent, remoteChild, localChild], {
      activeWorktreeId: localChild.id,
      activeWorkspaceExecutionHostId: 'local',
      settings: { showPinnedWorktreesInGroups: false }
    })

    createSetWorktreesPinnedAndReveal(get)(
      [{ worktreeId: remoteParent.id, executionHostId: 'ssh:host-b' }],
      true
    )

    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      {
        worktreeId: remoteParent.id,
        updates: { isPinned: true },
        executionHostId: 'ssh:host-b'
      }
    ])
  })
})

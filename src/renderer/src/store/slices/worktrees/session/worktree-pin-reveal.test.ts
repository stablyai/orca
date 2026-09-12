import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { createSetWorktreesPinnedAndReveal } from './worktree-pin-reveal'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/feature',
    repoId: 'repo',
    path: '/feature',
    branch: 'feature',
    isMainWorktree: false,
    isPinned: false,
    ...overrides
  } as Worktree
}

function sliceState(worktrees: Worktree[]) {
  const state = {
    activeWorkspaceKey: null,
    activeWorktreeId: null,
    worktreeLineageById: {},
    settings: null,
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    // Unqualified lookups return the first row with the id, exactly like the real index.
    getKnownWorktreeById: (worktreeId: string, executionHostId?: string) =>
      worktrees.find(
        (candidate) =>
          candidate.id === worktreeId &&
          (executionHostId === undefined || (candidate.hostId ?? 'local') === executionHostId)
      )
  }
  return { state, get: (() => state) as unknown as WorktreeSliceGet }
}

describe('setWorktreesPinnedAndReveal', () => {
  it('writes to the host named by a qualified target, not the first id match', () => {
    const local = worktree({ hostId: 'local' })
    const remote = worktree({ hostId: 'ssh:build' })
    const { state, get } = sliceState([local, remote])

    createSetWorktreesPinnedAndReveal(vi.fn() as unknown as WorktreeSliceSet, get)(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'ssh:build' }
    ])
  })

  it('keeps the bare-id form working for callers that do not know the host', () => {
    const { state, get } = sliceState([worktree({ hostId: 'local' })])

    createSetWorktreesPinnedAndReveal(vi.fn() as unknown as WorktreeSliceSet, get)(
      ['repo::/feature'],
      true
    )

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'local' }
    ])
  })

  it('skips a qualified target already in the requested state', () => {
    const { state, get } = sliceState([worktree({ hostId: 'ssh:build', isPinned: true })])

    createSetWorktreesPinnedAndReveal(vi.fn() as unknown as WorktreeSliceSet, get)(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it('routes a folder workspace through the single-row meta update', () => {
    const { state, get } = sliceState([
      worktree({ id: 'folder:abc', path: '/folder', hostId: 'ssh:build' })
    ])

    createSetWorktreesPinnedAndReveal(vi.fn() as unknown as WorktreeSliceSet, get)(
      [{ worktreeId: 'folder:abc', executionHostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreeMeta).toHaveBeenCalledWith(
      'folder:abc',
      { isPinned: true },
      { executionHostId: 'ssh:build' }
    )
    expect(state.updateWorktreesMeta).not.toHaveBeenCalled()
  })
})

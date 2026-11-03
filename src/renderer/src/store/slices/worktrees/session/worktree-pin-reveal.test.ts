import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { createSetWorktreesPinnedAndReveal } from './worktree-pin-reveal'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these are the only fields the pin path reads; the cast supplies the rest of the row shape.
const ROW = {
  id: 'repo::/feature',
  repoId: 'repo',
  path: '/feature',
  branch: 'feature',
  isMainWorktree: false,
  isPinned: false
} as Worktree

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return { ...ROW, ...overrides }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the creator never calls `set`; every write under test lands on the mocked updaters reached through `get`.
const UNUSED_SET = vi.fn() as unknown as WorktreeSliceSet

function sliceState(worktrees: Worktree[]) {
  const state = {
    activeWorkspaceKey: null,
    activeWorktreeId: null,
    worktreeLineageById: {},
    worktreesByRepo: { repo: worktrees },
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock names every field this suite exercises; the cast only supplies the rest of the slice.
  return { state, get: (() => state) as unknown as WorktreeSliceGet }
}

describe('setWorktreesPinnedAndReveal', () => {
  it('writes to the host named by a qualified target, not the first id match', () => {
    const local = worktree({ hostId: 'local' })
    const remote = worktree({ hostId: 'ssh:build' })
    const { state, get } = sliceState([local, remote])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ id: 'repo::/feature', hostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'ssh:build' }
    ])
  })

  it('writes a host-less target when only one host publishes the id', () => {
    const { state, get } = sliceState([worktree({ hostId: 'local' })])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)([{ id: 'repo::/feature' }], true)

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'local' }
    ])
  })

  it('skips a qualified target already in the requested state', () => {
    const { state, get } = sliceState([worktree({ hostId: 'ssh:build', isPinned: true })])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ id: 'repo::/feature', hostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it('routes a folder workspace through the single-row meta update', () => {
    const { state, get } = sliceState([
      worktree({ id: 'folder:abc', path: '/folder', hostId: 'ssh:build' })
    ])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ id: 'folder:abc', hostId: 'ssh:build' }],
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

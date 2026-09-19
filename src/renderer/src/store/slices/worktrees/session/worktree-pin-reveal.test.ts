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

function sliceState(worktrees: Worktree[], active: Record<string, unknown> = {}) {
  const state = {
    activeWorkspaceKey: null,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    ...active,
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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock names every field this suite exercises; the cast only supplies the rest of the slice.
  return { state, get: (() => state) as unknown as WorktreeSliceGet }
}

describe('setWorktreesPinnedAndReveal', () => {
  it('writes to the host named by a qualified target, not the first id match', () => {
    const local = worktree({ hostId: 'local' })
    const remote = worktree({ hostId: 'ssh:build' })
    const { state, get } = sliceState([local, remote])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'ssh:build' }
    ])
  })

  it('keeps the bare-id form working for callers that do not know the host', () => {
    const { state, get } = sliceState([worktree({ hostId: 'local' })])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(['repo::/feature'], true)

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'local' }
    ])
  })

  it('skips a qualified target already in the requested state', () => {
    const { state, get } = sliceState([worktree({ hostId: 'ssh:build', isPinned: true })])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).not.toHaveBeenCalled()
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it('reveals a changed row the active host owns', () => {
    const { state, get } = sliceState([worktree({ hostId: 'ssh:build' })], {
      activeWorktreeId: 'repo::/feature',
      activeWorkspaceExecutionHostId: 'ssh:build'
    })

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )

    expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith('repo::/feature', {
      behavior: 'smooth',
      highlight: true
    })
  })

  it('does not reveal when the changed row is a twin of the active one on another host', () => {
    const local = worktree({ hostId: 'local' })
    const remote = worktree({ hostId: 'ssh:build' })
    const { state, get } = sliceState([local, remote], {
      activeWorktreeId: 'repo::/feature',
      activeWorkspaceExecutionHostId: 'local'
    })

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
      true
    )

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'ssh:build' }
    ])
    expect(state.revealWorktreeInSidebar).not.toHaveBeenCalled()
  })

  it('routes a folder workspace through the single-row meta update', () => {
    const { state, get } = sliceState([
      worktree({ id: 'folder:abc', path: '/folder', hostId: 'ssh:build' })
    ])

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
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

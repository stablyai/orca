import { describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { isExecutionHostAliasForWorktree } from '@/lib/worktree-execution-host-alias'
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
    worktreeLineageById: {},
    settings: null,
    ...active,
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta: vi.fn(),
    revealWorktreeInSidebar: vi.fn(),
    // Unqualified lookups return the first row with the id, and a runtime alias resolves its
    // paired SSH row, exactly like the real index.
    getKnownWorktreeById: (worktreeId: string, executionHostId?: ExecutionHostId) =>
      worktrees.find(
        (candidate) =>
          candidate.id === worktreeId &&
          (executionHostId === undefined ||
            isExecutionHostAliasForWorktree(executionHostId, candidate))
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
      highlight: true,
      executionHostId: 'ssh:build'
    })
  })

  it('reveals the active paired-HUB row, whose physical host is the SSH route behind the runtime alias', () => {
    const paired = worktree({ hostId: 'ssh:build', runtimeOwnerEnvironmentId: 'env-1' })
    const { state, get } = sliceState([paired], {
      activeWorktreeId: 'repo::/feature',
      activeWorkspaceExecutionHostId: 'runtime:env-1'
    })

    createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
      [{ worktreeId: 'repo::/feature', executionHostId: 'runtime:env-1' }],
      true
    )

    expect(state.updateWorktreesMeta).toHaveBeenCalledWith([
      { worktreeId: 'repo::/feature', updates: { isPinned: true }, executionHostId: 'ssh:build' }
    ])
    expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith('repo::/feature', {
      behavior: 'smooth',
      highlight: true,
      executionHostId: 'ssh:build'
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

  describe('lineage reveal with local and SSH twins of a parent and its child', () => {
    const CHILD_LINEAGE: WorktreeLineage = {
      worktreeId: 'repo::/child',
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: 'repo::/feature',
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 0
    }
    function twinsOnHost(hostId: ExecutionHostId): Worktree[] {
      return [
        worktree({ hostId, instanceId: 'parent-instance' }),
        worktree({ id: 'repo::/child', path: '/child', hostId, instanceId: 'child-instance' })
      ]
    }
    const rows = [...twinsOnHost('local'), ...twinsOnHost('ssh:build')]

    it('does not reveal the active local child when only its parent twin on another host changed', () => {
      const { state, get } = sliceState(rows, {
        activeWorktreeId: 'repo::/child',
        activeWorkspaceExecutionHostId: 'local',
        worktreeLineageById: { 'repo::/child': CHILD_LINEAGE }
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

    it('reveals the active remote child on its own host when its parent there changed', () => {
      const { state, get } = sliceState(rows, {
        activeWorktreeId: 'repo::/child',
        activeWorkspaceExecutionHostId: 'ssh:build',
        worktreeLineageById: { 'repo::/child': CHILD_LINEAGE }
      })

      createSetWorktreesPinnedAndReveal(UNUSED_SET, get)(
        [{ worktreeId: 'repo::/feature', executionHostId: 'ssh:build' }],
        true
      )

      expect(state.revealWorktreeInSidebar).toHaveBeenCalledWith('repo::/child', {
        behavior: 'smooth',
        highlight: true,
        executionHostId: 'ssh:build'
      })
    })
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

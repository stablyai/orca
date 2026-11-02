import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  makeDetectedResult,
  qualifyDetectedResult
} from '@/store/slices/worktrees-detected-listing-fixtures'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '@/store/slices/worktrees-slice-test-harness'
import { runAsAutomaticDeselection } from '@/store/active-worktree-deselection-intent'
import { installActiveWorktreeRemovalSuccessor } from './active-worktree-removal-successor'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

import { activateAndRevealWorktree } from '@/lib/worktree-activation'

const row = (path: string, isMainWorktree = false): ReturnType<typeof makeWorktree> =>
  makeWorktree({ id: `repo1::${path}`, repoId: 'repo1', path, hostId: 'local', isMainWorktree })
const active = row('/active')
const recent = row('/recent')
const older = row('/older')
const main = row('/main', true)

let dispose: (() => void) | null = null

function setup(state: Partial<AppState> = {}): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  store.setState({
    worktreesByRepo: { repo1: [active, recent, older, main] },
    activeWorktreeId: active.id,
    activeWorkspaceExecutionHostId: 'local',
    activeView: 'terminal',
    activePendingCreationId: null,
    lastVisitedAtByWorktreeId: { [recent.id]: 200, [older.id]: 100 },
    ...state
  })
  dispose = installActiveWorktreeRemovalSuccessor(store)
  return store
}

// A refresh that no longer lists the active row: CLI, git, another client, or a delete that partly failed.
async function refreshWithout(
  store: ReturnType<typeof createTestStore>,
  rows: ReturnType<typeof makeWorktree>[]
): Promise<void> {
  mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
    qualifyDetectedResult(args, makeDetectedResult('repo1', rows))
  )
  await store.getState().fetchWorktrees('repo1')
  await Promise.resolve()
}

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
  vi.mocked(activateAndRevealWorktree).mockReset()
})

afterEach(() => {
  dispose?.()
  dispose = null
})

describe('active worktree removal successor', () => {
  it('moves to the most recently visited sibling, on its host, when the active row leaves the list', async () => {
    // Opened while its own delete was running: no "was viewing" snapshot is involved.
    const store = setup({
      deleteStateByWorktreeId: {
        [active.id]: {
          isDeleting: true,
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })

    await refreshWithout(store, [recent, older, main])

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(activateAndRevealWorktree).toHaveBeenCalledOnce()
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(recent.id, {
      revealInSidebar: false,
      executionHostId: 'local'
    })
    // Orca picked the successor, not the user: no switch that could start a stopped distro.
    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[1]).not.toHaveProperty(
      'navigationIntent'
    )
  })

  it('hands off after forgetting a paired row selected through its physical SSH alias', async () => {
    const paired = { ...active, hostId: 'ssh:paired' as const, runtimeOwnerEnvironmentId: 'hub' }
    const store = setup({
      worktreesByRepo: { repo1: [paired, recent, main] },
      activeWorkspaceExecutionHostId: 'ssh:paired'
    })
    const result = await store
      .getState()
      .removeWorktree({ id: paired.id, executionHostId: 'ssh:paired' }, false, {
        mode: 'forget-local'
      })
    expect(result).toEqual({ ok: true })
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(recent.id, {
      revealInSidebar: false,
      executionHostId: 'local'
    })
  })

  it('skips siblings still being deleted and falls back to the main workspace', async () => {
    const deleting = {
      isDeleting: true,
      error: null,
      canForceDelete: false,
      forceDeleteReason: null
    }
    const store = setup({
      deleteStateByWorktreeId: {
        [recent.id]: deleting,
        [older.id]: { ...deleting, phase: 'queued' }
      }
    })

    await refreshWithout(store, [recent, older, main])

    expect(activateAndRevealWorktree).toHaveBeenCalledWith(main.id, {
      revealInSidebar: false,
      executionHostId: 'local'
    })
  })

  it('hands off when a process exit emptied the workspace before the refresh dropped its row', async () => {
    const store = setup()
    // The host kills the workspace's terminals first; the last one's exit lands on the empty screen.
    runAsAutomaticDeselection(() =>
      store.setState({ activeWorktreeId: null, activeWorkspaceExecutionHostId: null })
    )
    await Promise.resolve()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    await refreshWithout(store, [recent, older, main])

    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[0]).toBe(recent.id)
  })

  it('hands off when the row drops before its selection is cleared', async () => {
    const store = setup()
    // Startup merges a listing without purging, and the prune clears the pointer later.
    store.setState({ worktreesByRepo: { repo1: [recent, older, main] } })
    await Promise.resolve()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    store.getState().pruneLastVisitedTimestamps()
    await Promise.resolve()

    expect(vi.mocked(activateAndRevealWorktree).mock.calls[0]?.[0]).toBe(recent.id)
  })

  it('does not treat a rename as a removal', async () => {
    const store = setup()
    const renamed = row('/renamed')
    // A rename moves the pointer to the new id before the listing swaps the rows.
    store.setState({ activeWorktreeId: renamed.id })
    store.setState({ worktreesByRepo: { repo1: [renamed, recent, older, main] } })
    await Promise.resolve()

    expect(store.getState().activeWorktreeId).toBe(renamed.id)
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not move the user when the row is still listed or they are not on the workspace view', async () => {
    const store = setup()
    // The user closing the last tab clears the selection while the row stays listed.
    store.setState({ activeWorktreeId: null, activeWorkspaceExecutionHostId: null })
    await refreshWithout(store, [recent, older, main])
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    store.setState({
      worktreesByRepo: { repo1: [active, recent, older, main] },
      activeWorktreeId: active.id,
      activeWorkspaceExecutionHostId: 'local',
      activeView: 'tasks'
    })
    await refreshWithout(store, [recent, older, main])

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('clears a saved pointer that was never listed without picking a successor', async () => {
    // The web client restores a pointer from localStorage that the server no longer reports.
    const store = setup({ activeWorktreeId: 'repo1::/gone' })

    store.getState().pruneLastVisitedTimestamps()
    await Promise.resolve()

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})

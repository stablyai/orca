// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() }
}))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))

import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'
import { getDeleteStateForWorktreeHost } from '../sidebar/worktree-delete-state-host-match'
import { useWorkspaceCleanupRemoval } from './use-workspace-cleanup-removal'

const REPO_ID = 'repo-1'
const initialState = useAppStore.getInitialState()

function worktreeId(name: string): string {
  return `${REPO_ID}::/repo/${name}`
}

// Production-shaped: the scan qualifies local rows as `local`, while the sidebar rows stay unhosted.
function candidateFor(name: string) {
  return makeCandidate({
    worktreeId: worktreeId(name),
    executionHostId: 'local',
    displayName: name,
    branch: name,
    path: `/repo/${name}`
  })
}

// Mirrors the store: a removed row leaves the catalog, and deleting the active one clears focus.
function simulateRemoval(ids: readonly string[]): WorkspaceCleanupRemoveResult {
  const removed = new Set(ids)
  useAppStore.setState((state) => ({
    worktreesByRepo: {
      [REPO_ID]: (state.worktreesByRepo[REPO_ID] ?? []).filter((wt) => !removed.has(wt.id))
    },
    activeWorktreeId:
      state.activeWorktreeId && removed.has(state.activeWorktreeId) ? null : state.activeWorktreeId
  }))
  return {
    removedIds: [...ids],
    // The store reports the removed scan row's identity, which carries the `local` host.
    removedIdentities: ids.map((id) =>
      getWorkspaceCleanupCandidateIdentity({ worktreeId: id, executionHostId: 'local' })
    ),
    failures: []
  }
}

function failRemoval(name: string): WorkspaceCleanupRemoveResult {
  return {
    removedIds: [],
    removedIdentities: [],
    failures: [{ worktreeId: worktreeId(name), displayName: name, message: 'locked' }]
  }
}

function seed(activeName: string): void {
  Object.assign(window, { api: { workspaceCleanup: {} } })
  useAppStore.setState({
    activeView: 'terminal',
    activePendingCreationId: null,
    activeWorktreeId: worktreeId(activeName),
    // Unhosted sidebar rows, as a local workspace with no stored host is recorded.
    worktreesByRepo: {
      [REPO_ID]: ['main', 'keep', 'active', 'longer-name', 'c'].map((name) =>
        makeWorktree({
          id: worktreeId(name),
          repoId: REPO_ID,
          path: `/repo/${name}`,
          isMainWorktree: name === 'main'
        })
      )
    },
    // c is more recent than keep, so landing on keep proves a still-queued batch row is skipped.
    lastVisitedAtByWorktreeId: {
      [worktreeId('keep')]: 100,
      [worktreeId('longer-name')]: 300,
      [worktreeId('c')]: 200
    },
    removeWorkspaceCleanupCandidates: vi.fn(async (ids: readonly string[]) => simulateRemoval(ids))
  })
}

function renderRemoval() {
  return renderHook(() =>
    useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
  )
}

type PendingRemoval = {
  ids: readonly string[]
  settle: (result: WorkspaceCleanupRemoveResult) => void
}

// Each row's removal stays pending until the test settles it, like a slow IPC delete.
function deferRemovals(): PendingRemoval[] {
  const pending: PendingRemoval[] = []
  useAppStore.setState({
    removeWorkspaceCleanupCandidates: vi.fn(
      (ids: readonly string[]) =>
        new Promise<WorkspaceCleanupRemoveResult>((resolve) => {
          pending.push({ ids, settle: resolve })
        })
    )
  })
  return pending
}

async function runBatch(names: readonly string[]): Promise<void> {
  const { result } = renderRemoval()
  act(() => result.current.openConfirmRemove(names.map(candidateFor)))
  act(() => result.current.confirmRemove())
  await waitFor(() => expect(result.current.removalInFlight).toBe(false))
}

async function settleNext(
  pending: PendingRemoval[],
  index: number,
  result?: WorkspaceCleanupRemoveResult
): Promise<void> {
  await waitFor(() => expect(pending.length).toBeGreaterThan(index))
  await act(async () => pending[index].settle(result ?? simulateRemoval(pending[index].ids)))
}

function startBatch(names: readonly string[]) {
  const rendered = renderRemoval()
  act(() => rendered.result.current.openConfirmRemove(names.map(candidateFor)))
  act(() => rendered.result.current.confirmRemove())
  return rendered
}

// Rows run longest path first: longer-name, then active, then c.
const BATCH = ['c', 'active', 'longer-name'] as const
const KEEP_FOCUS = [worktreeId('keep'), { revealInSidebar: false }] as const

describe('workspace cleanup removal of the active workspace', () => {
  beforeEach(() => {
    vi.mocked(activateAndRevealWorktree).mockReset()
    // Mirrors real activation so later reads see the new active workspace.
    vi.mocked(activateAndRevealWorktree).mockImplementation((id) => {
      useAppStore.setState({ activeWorktreeId: id })
      return false
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    Reflect.deleteProperty(window, 'api')
  })

  it('stays on the active workspace until its row is removed, then hands off while later rows are pending', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = startBatch(BATCH)

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    await settleNext(pending, 0)
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('active'))

    // c is still queued (unhosted card, `local`-qualified cleanup target), so keep wins over it.
    await settleNext(pending, 1)
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(...KEEP_FOCUS)
    expect(result.current.removalInFlight).toBe(true)

    await settleNext(pending, 2)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('keep'))
  })

  it('shows every confirmed row as queued on its unhosted sidebar card', () => {
    seed('active')
    deferRemovals()
    startBatch(BATCH)

    const deleteState = useAppStore.getState().deleteStateByWorktreeId
    for (const name of BATCH) {
      expect(
        getDeleteStateForWorktreeHost({ id: worktreeId(name), hostId: undefined }, deleteState)
      ).toMatchObject({ isDeleting: true, phase: 'queued' })
    }
  })

  it('stays on the active workspace when its delete fails', async () => {
    seed('active')
    const pending = deferRemovals()
    const { result } = startBatch(BATCH)
    await settleNext(pending, 0)
    await settleNext(pending, 1, failRemoval('active'))
    await settleNext(pending, 2)
    await waitFor(() => expect(result.current.removalInFlight).toBe(false))

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('active'))
  })

  it('leaves the user where they went if they left the active workspace before it was removed', async () => {
    seed('active')
    const pending = deferRemovals()
    startBatch(BATCH)
    await settleNext(pending, 0)

    act(() => useAppStore.setState({ activeWorktreeId: worktreeId('main') }))
    await settleNext(pending, 1)
    await settleNext(pending, 2)

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('main'))
  })

  it('still hands off after the dialog closes mid-batch', async () => {
    seed('active')
    const pending = deferRemovals()
    const { unmount } = startBatch(BATCH)
    await settleNext(pending, 0)

    unmount()
    await settleNext(pending, 1)
    await settleNext(pending, 2)

    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(...KEEP_FOCUS)
  })

  it('hands off when Delete anyway removes the active workspace', async () => {
    seed('active')
    const pending = deferRemovals()
    useAppStore.setState({ beginUnverifiedRemovalConsent: () => 'attempt-1' })
    const { result } = renderRemoval()

    act(() => result.current.confirmUnverifiedRemoval(candidateFor('active')))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()

    await settleNext(pending, 0)
    expect(activateAndRevealWorktree).toHaveBeenCalledTimes(1)
    expect(activateAndRevealWorktree).toHaveBeenCalledWith(worktreeId('longer-name'), {
      revealInSidebar: false
    })
  })

  it('keeps deleting when the focus handoff throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(activateAndRevealWorktree).mockImplementationOnce(() => {
      throw new Error('activation failed')
    })
    seed('active')

    await runBatch(BATCH)

    expect(consoleError).toHaveBeenCalled()
    expect(useAppStore.getState().worktreesByRepo[REPO_ID]?.map((wt) => wt.id)).toEqual([
      worktreeId('main'),
      worktreeId('keep')
    ])
    consoleError.mockRestore()
  })

  it('leaves focus alone when the batch does not include the active workspace', async () => {
    seed('keep')

    await runBatch(['c', 'active'])

    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId('keep'))
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it.each([
    ['another view is open', { activeView: 'settings' as const }],
    ['a workspace is being created', { activePendingCreationId: 'pending-1' }]
  ])('leaves focus alone when %s', async (_label, override) => {
    seed('active')
    useAppStore.setState(override)

    await runBatch(BATCH)

    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})

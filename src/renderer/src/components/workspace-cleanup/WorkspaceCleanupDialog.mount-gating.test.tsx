// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type {
  WorkspaceCleanupCandidate,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import type * as WorkspaceCleanupPresentation from './workspace-cleanup-presentation'
import WorkspaceCleanupDialog from './WorkspaceCleanupDialog'
import { NOW, makeCandidate, makeState } from './workspace-cleanup-presentation-fixtures'

const contentProbe = vi.hoisted(() => ({
  mounts: vi.fn(),
  projections: vi.fn(),
  renders: vi.fn(),
  storeNotifications: vi.fn(),
  unmounts: vi.fn()
}))

const toastProbe = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  message: vi.fn(),
  success: vi.fn(),
  warning: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastProbe }))

vi.mock('./workspace-cleanup-presentation', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceCleanupPresentation>()
  return {
    ...actual,
    filterWorkspaceCleanupCandidates: (
      ...args: Parameters<typeof actual.filterWorkspaceCleanupCandidates>
    ) => {
      contentProbe.projections()
      return actual.filterWorkspaceCleanupCandidates(...args)
    },
    getWorkspaceCleanupReviewInfo: (
      ...args: Parameters<typeof actual.getWorkspaceCleanupReviewInfo>
    ) => {
      contentProbe.projections()
      return actual.getWorkspaceCleanupReviewInfo(...args)
    },
    sortWorkspaceCleanupCandidates: (
      ...args: Parameters<typeof actual.sortWorkspaceCleanupCandidates>
    ) => {
      contentProbe.projections()
      return actual.sortWorkspaceCleanupCandidates(...args)
    }
  }
})

vi.mock('@/components/ui/dialog', async () => {
  const React = await import('react')
  const Passthrough = ({ children }: { children: React.ReactNode }) => <>{children}</>
  const DialogContent = () => {
    contentProbe.renders()
    React.useEffect(() => {
      contentProbe.mounts()
      const unsubscribe = useAppStore.subscribe(() => contentProbe.storeNotifications())
      return () => {
        contentProbe.unmounts()
        unsubscribe()
      }
    }, [])
    // Why: render while closed so the marker measures Orca's content gate, not Radix's portal gate.
    return <div data-workspace-cleanup-heavy-content="true" />
  }
  return {
    Dialog: Passthrough,
    DialogContent,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough
  }
})

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

const initialAppState = useAppStore.getInitialState()
const fixtureState = makeState()
const initialCandidate = makeCandidate()
const initialScan = makeScan(1, initialCandidate)
let testContainer: HTMLDivElement
let testRoot: Root

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function makeScan(index: number, candidate: WorkspaceCleanupCandidate): WorkspaceCleanupScanResult {
  return {
    scannedAt: NOW + index,
    candidates: [candidate],
    errors: []
  }
}

function makeChurnCandidate(index: number): WorkspaceCleanupCandidate {
  return makeCandidate({
    worktreeId: `repo-1::/repo/background-${index}`,
    displayName: `background-${index}`,
    path: `/repo/background-${index}`,
    fingerprint: `background-${index}`
  })
}

function activeContentSubscriptions(): number {
  return contentProbe.mounts.mock.calls.length - contentProbe.unmounts.mock.calls.length
}

function requireStoreListenerCount(): number {
  const count = readStoreListenerCount()
  expect(count).not.toBeNull()
  return count ?? 0
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderDialog(): Promise<void> {
  await act(async () => testRoot.render(<WorkspaceCleanupDialog />))
  await flushEffects()
}

async function openDialog(): Promise<void> {
  await act(async () => useAppStore.getState().openModal('workspace-cleanup'))
  await flushEffects()
}

async function closeDialog(): Promise<void> {
  await act(async () => useAppStore.getState().closeModal())
  await flushEffects()
}

async function publishScanProgress(index: number): Promise<void> {
  const scan = makeScan(index, makeChurnCandidate(index))
  await act(async () => {
    useAppStore.setState({
      workspaceCleanupScan: scan,
      workspaceCleanupProgress: {
        ...scan,
        scanId: `scan-${index}`,
        scannedWorktreeCount: 1,
        totalWorktreeCount: 1
      }
    })
  })
}

async function publishReviewChurn(index: number): Promise<void> {
  await act(async () => {
    useAppStore.setState({
      hostedReviewCache: {
        [`background-${index}`]: { data: null, fetchedAt: NOW + index }
      }
    })
  })
}

async function publishDeleteChurn(index: number): Promise<void> {
  const candidate = makeChurnCandidate(index)
  await act(async () => {
    useAppStore.setState({
      deleteStateByWorktreeId: {
        [candidate.worktreeId]: {
          isDeleting: true,
          phase: 'queued',
          error: null,
          canForceDelete: false,
          forceDeleteReason: null
        }
      }
    })
  })
}

function seedStore(
  scanWorkspaceCleanup: AppState['scanWorkspaceCleanup'] = vi.fn(async () => initialScan)
): void {
  useAppStore.setState(initialAppState, true)
  useAppStore.setState({
    activeModal: 'none',
    repos: fixtureState.repos,
    worktreesByRepo: fixtureState.worktreesByRepo,
    hostedReviewCache: {},
    deleteStateByWorktreeId: {},
    workspaceCleanupScan: initialScan,
    workspaceCleanupProgress: null,
    workspaceCleanupLoading: false,
    workspaceCleanupError: null,
    scanWorkspaceCleanup
  })
}

describe('WorkspaceCleanupDialog mount gating', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    Object.values(contentProbe).forEach((probe) => probe.mockClear())
    Object.values(toastProbe).forEach((probe) => probe.mockClear())
    seedStore()
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => testRoot.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('keeps heavy content through 299 ms, then drops its projections and subscriptions', async () => {
    const listenerBaseline = requireStoreListenerCount()
    await renderDialog()
    const shellListenerCount = requireStoreListenerCount()

    expect(shellListenerCount).toBe(listenerBaseline + 1)
    expect(testContainer.querySelector('[data-workspace-cleanup-heavy-content]')).toBeNull()
    expect(activeContentSubscriptions()).toBe(0)

    await openDialog()
    const openListenerCount = requireStoreListenerCount()

    expect(testContainer.querySelector('[data-workspace-cleanup-heavy-content]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)
    expect(openListenerCount).toBeGreaterThan(shellListenerCount)

    await closeDialog()
    await act(async () => vi.advanceTimersByTimeAsync(299))

    expect(testContainer.querySelector('[data-workspace-cleanup-heavy-content]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)

    const lingeringProjectionCount = contentProbe.projections.mock.calls.length
    const lingeringNotificationCount = contentProbe.storeNotifications.mock.calls.length
    await publishScanProgress(2)
    await publishReviewChurn(2)
    await publishDeleteChurn(2)

    expect(contentProbe.projections.mock.calls.length).toBeGreaterThan(lingeringProjectionCount)
    expect(contentProbe.storeNotifications.mock.calls.length).toBeGreaterThan(
      lingeringNotificationCount
    )

    await act(async () => vi.advanceTimersByTimeAsync(1))

    expect(testContainer.querySelector('[data-workspace-cleanup-heavy-content]')).toBeNull()
    expect(activeContentSubscriptions()).toBe(0)
    expect(requireStoreListenerCount()).toBe(shellListenerCount)

    const hiddenProjectionCount = contentProbe.projections.mock.calls.length
    const hiddenRenderCount = contentProbe.renders.mock.calls.length
    const hiddenNotificationCount = contentProbe.storeNotifications.mock.calls.length
    for (let index = 3; index < 103; index += 1) {
      await publishScanProgress(index)
      await publishReviewChurn(index)
      await publishDeleteChurn(index)
    }

    expect(contentProbe.projections).toHaveBeenCalledTimes(hiddenProjectionCount)
    expect(contentProbe.renders).toHaveBeenCalledTimes(hiddenRenderCount)
    expect(contentProbe.storeNotifications).toHaveBeenCalledTimes(hiddenNotificationCount)
  })

  it('cancels the pending content unmount when reopened during the linger', async () => {
    await renderDialog()
    await openDialog()
    await closeDialog()
    await act(async () => vi.advanceTimersByTimeAsync(299))
    await openDialog()
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(testContainer.querySelector('[data-workspace-cleanup-heavy-content]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)

    const projectionCount = contentProbe.projections.mock.calls.length
    await publishScanProgress(4)
    expect(contentProbe.projections.mock.calls.length).toBeGreaterThan(projectionCount)
  })

  it('toasts when an open-time scan settles after the closed content unmounts', async () => {
    const pendingScan = deferred<WorkspaceCleanupScanResult>()
    const scanWorkspaceCleanup = vi.fn(() => pendingScan.promise)
    seedStore(scanWorkspaceCleanup)
    await renderDialog()
    await openDialog()

    expect(scanWorkspaceCleanup).toHaveBeenCalledTimes(1)

    await closeDialog()
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(testContainer.querySelector('[data-workspace-cleanup-heavy-content]')).toBeNull()

    const completedScan = makeScan(5, makeChurnCandidate(5))
    await act(async () => {
      pendingScan.resolve(completedScan)
      await pendingScan.promise
      await Promise.resolve()
    })
    await flushEffects()

    expect(toastProbe.success).toHaveBeenCalledWith(
      'Inactive workspace scan ready',
      expect.objectContaining({
        action: expect.objectContaining({ label: 'Review' })
      })
    )
  })
})

// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup'
import {
  useWorkspaceCleanupDialogSession,
  type WorkspaceCleanupDialogSession
} from './workspace-cleanup-dialog-session'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastMocks }))

const initialAppState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root
let currentSession: WorkspaceCleanupDialogSession | null

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

function Probe(): null {
  currentSession = useWorkspaceCleanupDialogSession()
  return null
}

function session(): WorkspaceCleanupDialogSession {
  if (!currentSession) {
    throw new Error('Workspace cleanup session probe is not mounted')
  }
  return currentSession
}

async function renderProbe(): Promise<void> {
  await act(async () => root.render(<Probe />))
}

describe('useWorkspaceCleanupDialogSession', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      activeModal: 'workspace-cleanup',
      workspaceCleanupLoading: false,
      deleteStateByWorktreeId: {}
    })
    currentSession = null
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    currentSession = null
    useAppStore.setState(initialAppState, true)
  })

  it('offers to reopen when a scan finishes after the dialog closes', async () => {
    const candidate = makeCandidate()
    const scan = deferred<WorkspaceCleanupScanResult>()
    const scanWorkspaceCleanup = vi.fn(() => scan.promise)
    useAppStore.setState({ scanWorkspaceCleanup })

    await renderProbe()
    expect(scanWorkspaceCleanup).toHaveBeenCalledOnce()

    await act(async () => useAppStore.getState().closeModal())
    expect(session().open).toBe(false)

    await act(async () => {
      scan.resolve({ scannedAt: 42, candidates: [candidate], errors: [] })
      await scan.promise
    })

    expect(toastMocks.success).toHaveBeenCalledWith(
      'Inactive workspace scan ready',
      expect.objectContaining({
        description: '1 inactive workspace found, with 1 cleanup suggestion.',
        action: expect.objectContaining({ label: 'Review' })
      })
    )
    const options = toastMocks.success.mock.lastCall?.[1] as {
      action?: { onClick: () => void }
    }

    await act(async () => options.action?.onClick())

    expect(useAppStore.getState().activeModal).toBe('workspace-cleanup')
    expect(session().open).toBe(true)
  })

  it('keeps a deferred removal alive and visible across close and reopen', async () => {
    const candidate = makeCandidate()
    const removal = deferred<WorkspaceCleanupRemoveResult>()
    const removeWorkspaceCleanupCandidates = vi.fn(() => removal.promise)
    const scanWorkspaceCleanup = vi.fn().mockResolvedValue({
      scannedAt: 41,
      candidates: [candidate],
      errors: []
    } satisfies WorkspaceCleanupScanResult)
    useAppStore.setState({ removeWorkspaceCleanupCandidates, scanWorkspaceCleanup })
    await renderProbe()

    await act(async () => session().openConfirmRemove([candidate]))
    await act(async () => session().confirmRemove())

    expect(removeWorkspaceCleanupCandidates).toHaveBeenCalledWith([candidate.worktreeId], {
      approvedCandidates: [candidate]
    })
    expect(session()).toMatchObject({
      open: true,
      confirming: true,
      removalInFlight: true,
      removalProgress: {
        totalCount: 1,
        processedCount: 0,
        removedCount: 0,
        failedCount: 0
      }
    })

    await act(async () => session().close())

    expect(session()).toMatchObject({
      open: false,
      confirming: true,
      removalInFlight: true
    })
    expect(session().removalProgress?.processedCount).toBe(0)

    await act(async () => useAppStore.getState().openModal('workspace-cleanup'))

    expect(session()).toMatchObject({
      open: true,
      confirming: true,
      removalInFlight: true
    })
    expect(session().removalProgress?.processedCount).toBe(0)
    expect(scanWorkspaceCleanup).toHaveBeenCalledOnce()

    await act(async () => {
      removal.resolve({ removedIds: [candidate.worktreeId], failures: [] })
      await removal.promise
      await Promise.resolve()
    })

    expect(session()).toMatchObject({
      open: true,
      confirming: false,
      confirmCandidates: [],
      removalInFlight: false,
      removalProgress: null
    })
  })
})

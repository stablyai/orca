// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { WorkspaceCleanupScanResult } from '../../../../shared/workspace-cleanup'
import WorkspaceCleanupDialog from './WorkspaceCleanupDialog'
import { WorkspaceCleanupScanSupersededError } from '@/store/slices/workspace-cleanup-broad-scan-registry'

const probes = vi.hoisted(() => ({ facets: vi.fn() }))
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))

vi.mock('sonner', () => ({ toast }))
vi.mock('./use-workspace-cleanup-facet-rows', () => ({
  useWorkspaceCleanupFacetRows: () => {
    probes.facets()
    return {
      rows: [],
      selectableIdentities: [],
      facetMatchedIdentities: new Set(),
      matchedCount: 0,
      totalCount: 0,
      facetCounts: {
        activity: 0,
        size: 0,
        status: 0,
        agent: 0,
        git: 0,
        review: 0,
        ticket: 0,
        context: 0,
        location: 0,
        safety: 0
      },
      options: { workspaceStatuses: [], hostIds: [], repos: [], reviewProviders: [] },
      reviewInfoByWorktreeId: new Map(),
      sizeByWorktreeId: new Map(),
      measuredSizeCount: 0,
      unmeasuredSizeCount: 0
    }
  }
}))
vi.mock('@/components/ui/dialog', async () => {
  const Passthrough = ({ children }: { children: ReactNode }) => <>{children}</>
  return {
    Dialog: Passthrough,
    DialogContent: () => <div data-workspace-cleanup-content="true" />
  }
})

const initialState = useAppStore.getInitialState()
let container: HTMLDivElement
let root: Root

function emptyScan(scannedAt: number): WorkspaceCleanupScanResult {
  return { scannedAt, candidates: [], errors: [] }
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function openDialog(): Promise<void> {
  await act(async () => useAppStore.getState().openModal('workspace-cleanup'))
  await flush()
}

async function closeDialog(): Promise<void> {
  await act(async () => useAppStore.getState().closeModal())
  await flush()
}

function seedStore(scanWorkspaceCleanup: AppState['scanWorkspaceCleanup']): void {
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    activeModal: 'none',
    workspaceCleanupScan: emptyScan(1),
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
    probes.facets.mockClear()
    toast.error.mockClear()
    toast.success.mockClear()
    seedStore(vi.fn(async () => emptyScan(2)))
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialState, true)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('drops heavy projections after the close animation', async () => {
    await act(async () => root.render(<WorkspaceCleanupDialog />))
    await flush()
    expect(probes.facets).not.toHaveBeenCalled()

    await openDialog()
    expect(probes.facets).toHaveBeenCalled()

    await closeDialog()
    await act(async () => vi.advanceTimersByTimeAsync(300))
    const hiddenCalls = probes.facets.mock.calls.length

    for (let index = 0; index < 100; index += 1) {
      await act(async () => {
        useAppStore.setState({
          workspaceCleanupScan: emptyScan(index + 10),
          hostedReviewCache: { [`review-${index}`]: { data: null, fetchedAt: index } },
          deleteStateByWorktreeId: {}
        })
      })
    }

    expect(probes.facets).toHaveBeenCalledTimes(hiddenCalls)
  })

  it('keeps scan completion ownership after heavy content unmounts', async () => {
    let resolveScan!: (result: WorkspaceCleanupScanResult) => void
    const scanPromise = new Promise<WorkspaceCleanupScanResult>((resolve) => {
      resolveScan = resolve
    })
    const scanWorkspaceCleanup = vi.fn(() => scanPromise)
    seedStore(scanWorkspaceCleanup)
    await act(async () => root.render(<WorkspaceCleanupDialog />))
    await openDialog()

    await closeDialog()
    await act(async () => vi.advanceTimersByTimeAsync(300))
    expect(container.querySelector('[data-workspace-cleanup-content]')).toBeNull()

    await act(async () => resolveScan(emptyScan(20)))
    await flush()

    expect(toast.success).toHaveBeenCalledWith(
      'Workspace scan ready',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Review' }) })
    )
  })

  it('does not report a superseded scan as a failure', async () => {
    seedStore(
      vi.fn(async () => {
        throw new WorkspaceCleanupScanSupersededError()
      })
    )
    await act(async () => root.render(<WorkspaceCleanupDialog />))

    await openDialog()

    expect(toast.error).not.toHaveBeenCalled()
  })
})

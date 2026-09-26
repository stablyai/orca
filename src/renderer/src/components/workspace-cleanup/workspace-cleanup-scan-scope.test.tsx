// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useRef } from 'react'
import type { WorkspaceCleanupScanScope } from '../../../../shared/workspace-cleanup'

const { scanWorkspaceCleanupMock, openModalMock, hydrateCleanupMock, hydrateSpaceMock } =
  vi.hoisted(() => ({
    scanWorkspaceCleanupMock: vi.fn(),
    openModalMock: vi.fn(),
    hydrateCleanupMock: vi.fn(),
    hydrateSpaceMock: vi.fn()
  }))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      scanWorkspaceCleanup: scanWorkspaceCleanupMock,
      hydrateWorkspaceCleanupFromCache: hydrateCleanupMock,
      hydrateWorkspaceSpaceFromCache: hydrateSpaceMock,
      openModal: openModalMock
    })
}))

vi.mock('@/store/slices/workspace-cleanup-broad-scan-registry', () => ({
  isWorkspaceCleanupScanSupersededError: () => false
}))

import { useWorkspaceCleanupScanLifecycle } from './use-workspace-cleanup-scan-lifecycle'

function useScanLifecycle(scope: WorkspaceCleanupScanScope | null) {
  const removalInFlightRef = useRef(false)
  return useWorkspaceCleanupScanLifecycle({
    // Why: closed, so the hook's own open-effect scan does not fire and every
    // recorded call is the one the test made.
    open: false,
    loading: false,
    removalInFlight: false,
    removalInFlightRef,
    resetRowFailures: () => {},
    onFreshOpen: () => {},
    scope
  })
}

describe('workspace cleanup scan scope', () => {
  beforeEach(() => {
    scanWorkspaceCleanupMock
      .mockReset()
      .mockResolvedValue({ scannedAt: 1, candidates: [], errors: [] })
    openModalMock.mockReset()
    hydrateCleanupMock.mockReset().mockResolvedValue(undefined)
    hydrateSpaceMock.mockReset().mockResolvedValue(undefined)
  })

  it('keeps the project scope on a rescan the caller did not parameterize', () => {
    // Why: Refresh calls startWorkspaceCleanupScan with no scope argument.
    // Before the scope moved into the hook that silently widened a
    // project-scoped dialog to every project — and with it came back the idle
    // prefilter that hides a branch merged today.
    const { result } = renderHook(() =>
      useScanLifecycle({ repoId: 'repo-1', executionHostId: 'local' })
    )

    act(() => result.current.startWorkspaceCleanupScan({ notifyWhenReady: true }))

    expect(scanWorkspaceCleanupMock).toHaveBeenCalledWith({
      repoId: 'repo-1',
      executionHostId: 'local'
    })
  })

  it('scans every project when the dialog was not scoped', () => {
    const { result } = renderHook(() => useScanLifecycle(null))

    act(() => result.current.startWorkspaceCleanupScan())

    expect(scanWorkspaceCleanupMock).toHaveBeenCalledWith(undefined)
  })

  it('omits the host when the scope carries only a project', () => {
    const { result } = renderHook(() => useScanLifecycle({ repoId: 'repo-1' }))

    act(() => result.current.startWorkspaceCleanupScan())

    expect(scanWorkspaceCleanupMock).toHaveBeenCalledWith({ repoId: 'repo-1' })
  })
})

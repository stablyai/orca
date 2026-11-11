// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPendingSetupGuideTourRequest,
  requestSetupGuideTourWhenReady
} from './FeatureWallSetupWorkflowActions'
import { useAppStore } from '@/store'

vi.mock('sonner', () => ({
  toast: {
    message: vi.fn(),
    success: vi.fn(),
    error: vi.fn()
  }
}))

const mountedRoots: Root[] = []

describe('setup guide workflow actions', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
    cancelPendingSetupGuideTourRequest()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
    useAppStore.setState({
      activeModal: 'none',
      modalData: {},
      activeWorktreeId: null,
      worktreesByRepo: {},
      tabsByWorktree: {},
      activeTabId: null,
      activeGroupIdByWorktree: {},
      terminalLayoutsByTabId: {},
      repos: [],
      activeRepoId: null,
      activeContextualTourId: null
    })
  })

  it('gates setup-guide tour retries on the expected destination surface', () => {
    vi.useFakeTimers()
    const requestContextualTour = vi.fn()
    useAppStore.setState({
      activeModal: 'none',
      activeContextualTourId: null,
      requestContextualTour: requestContextualTour as never
    })

    requestSetupGuideTourWhenReady({
      id: 'workspace-creation',
      source: 'setup_guide_parallel_work',
      shouldContinue: () => useAppStore.getState().activeModal === 'new-workspace-composer',
      retryDelayMs: 10,
      maxAttempts: 5
    })

    vi.advanceTimersByTime(50)

    expect(requestContextualTour).not.toHaveBeenCalled()

    cancelPendingSetupGuideTourRequest()
    vi.useRealTimers()
  })
})

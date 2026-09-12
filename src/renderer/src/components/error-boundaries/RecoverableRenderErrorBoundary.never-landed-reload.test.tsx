// @vitest-environment happy-dom

// The end-to-end shape of the 9 shipped lazy-chunk crash reports: a corrupt chunk
// fails, recovery requests a reload, the reload never lands, and the boundary files
// a react-error-boundary crash report instead of containing the failure.

import { Suspense, act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { lazyWithRetry, resetLazyChunkReloadRequestsForTest } from '@/lib/lazy-with-retry'
import { RecoverableRenderErrorBoundary } from './RecoverableRenderErrorBoundary'

const reportCrashMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: reportCrashMock
}))

const RELOAD_SETTLE_GRACE_MS = 10_000

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function BoundaryHarness({ children }: { children: ReactNode }): ReactElement {
  return (
    <RecoverableRenderErrorBoundary boundaryId="right-sidebar" surface="right-sidebar">
      <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
    </RecoverableRenderErrorBoundary>
  )
}

describe('RecoverableRenderErrorBoundary after a recovery reload never lands', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    reportCrashMock.mockReset()
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
    }
    container?.remove()
    root = null
    container = null
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    vi.restoreAllMocks()
    vi.useRealTimers()
    consoleError.mockRestore()
  })

  it('shows the fallback without filing a crash report', async () => {
    const LazyCorruptChunk = lazyWithRetry(
      () => Promise.reject(new SyntaxError("Unexpected token '}'")),
      { retries: 0, reloadKey: 'right-sidebar' }
    )
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <BoundaryHarness>
          <LazyCorruptChunk />
        </BoundaryHarness>
      )
    })

    // Outlive the reload settle grace window, then let React commit the rejection.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(RELOAD_SETTLE_GRACE_MS + 50)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(container?.querySelector('[role="alert"]')).not.toBeNull()
    // Before the fix the boundary received the raw SyntaxError and filed a report;
    // that is exactly what produced all 9 shipped crash reports.
    expect(reportCrashMock).not.toHaveBeenCalled()
  })
})

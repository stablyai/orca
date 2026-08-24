// @vitest-environment happy-dom

// The user-recovery gap behind the contained lazy-chunk crashes: after a corrupt
// chunk and a recovery reload that never lands, the boundary's Retry re-renders
// the same React.lazy, whose cached rejection can never re-invoke the factory —
// so a surface whose chunk has become loadable again (assets settled after an
// update) still stays dead until a full app restart.

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

type Breadcrumb = { name: string; data: Record<string, unknown> }

function installBreadcrumbSink(): Breadcrumb[] {
  const breadcrumbs: Breadcrumb[] = []
  ;(window as unknown as { api: unknown }).api = {
    crashReports: {
      recordBreadcrumb: (crumb: Breadcrumb) => {
        breadcrumbs.push(crumb)
      }
    }
  }
  return breadcrumbs
}

function BoundaryHarness({ children }: { children: ReactNode }): ReactElement {
  return (
    <RecoverableRenderErrorBoundary boundaryId="right-sidebar" surface="right-sidebar">
      <Suspense fallback={<div>Loading...</div>}>{children}</Suspense>
    </RecoverableRenderErrorBoundary>
  )
}

describe('RecoverableRenderErrorBoundary Retry after a recovery reload never lands', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    reportCrashMock.mockReset()
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    // Production truth: location.reload() produced zero navigations in the shipped bundles.
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
    delete (window as unknown as { api?: unknown }).api
    vi.restoreAllMocks()
    vi.useRealTimers()
    consoleError.mockRestore()
  })

  it('re-invokes the chunk factory on Retry and recovers the surface once assets settle', async () => {
    const breadcrumbs = installBreadcrumbSink()
    const HealedSurface = (): ReactElement => <div data-testid="healed-surface">healed</div>
    // First fetch reads the mid-update asset set; the retry reads the settled one.
    const chunkFactory = vi
      .fn<() => Promise<{ default: typeof HealedSurface }>>()
      .mockRejectedValueOnce(new SyntaxError("Unexpected token '}'"))
      .mockResolvedValue({ default: HealedSurface })
    // No reloadKey: matches the shipped call sites (reloadKey=unknown breadcrumbs).
    const LazyHealingChunk = lazyWithRetry(chunkFactory, { retries: 0 })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root?.render(
        <BoundaryHarness>
          <LazyHealingChunk />
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

    expect(container.querySelector('[role="alert"]')).not.toBeNull()
    expect(chunkFactory).toHaveBeenCalledTimes(1)
    expect(reportCrashMock).not.toHaveBeenCalled()
    const reload = breadcrumbs.find((crumb) => crumb.name === 'lazy_chunk_reload')
    expect(reload?.data.reloadKey).toBe('unknown')

    const retryButton = container.querySelector<HTMLButtonElement>('[role="alert"] button')
    expect(retryButton).not.toBeNull()
    await act(async () => {
      retryButton?.click()
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    // The whole defect: React.lazy cached the rejection, so Retry never re-invokes
    // the factory and the surface stays dead even though the chunk now loads.
    expect(chunkFactory).toHaveBeenCalledTimes(2)
    expect(container.querySelector('[data-testid="healed-surface"]')).not.toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(reportCrashMock).not.toHaveBeenCalled()
  })
})

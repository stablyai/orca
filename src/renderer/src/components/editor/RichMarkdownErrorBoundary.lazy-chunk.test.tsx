// @vitest-environment happy-dom

import { Suspense, act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { lazyWithRetry } from '@/lib/lazy-with-retry'
import {
  clearLazyChunkBreadcrumbDedupeForTest,
  RichMarkdownErrorBoundary
} from './RichMarkdownErrorBoundary'

const reportCrashMock = vi.hoisted(() => vi.fn())
const recordBreadcrumbMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: reportCrashMock
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: recordBreadcrumbMock
}))

const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
const LANDED_RELOAD_GUARD_VALUE = 'doc-before-the-reload'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function createContainer(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  return { container, root: createRoot(container) }
}

function BoundaryHarness({
  children,
  boundaryKey = 'pane-a'
}: {
  children: ReactNode
  boundaryKey?: string
}): ReactElement {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <RichMarkdownErrorBoundary key={boundaryKey} fileId="file-1">
        {children}
      </RichMarkdownErrorBoundary>
    </Suspense>
  )
}

async function flushReactWork(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const CORRUPT_CHUNK_PARSE_ERROR = "Unexpected token ':'"

describe('RichMarkdownErrorBoundary lazy chunk containment', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    reportCrashMock.mockReset()
    recordBreadcrumbMock.mockReset()
    clearLazyChunkBreadcrumbDedupeForTest()
    window.sessionStorage.clear()
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
    consoleError.mockRestore()
  })

  it('renders the fallback without reporting after guarded dynamic import exhaustion', async () => {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, LANDED_RELOAD_GUARD_VALUE)
    const LazyRejectingImport = lazyWithRetry(
      () => Promise.reject(new SyntaxError(CORRUPT_CHUNK_PARSE_ERROR)),
      { retries: 0, reloadKey: 'rich-markdown-editor' }
    )
    ;({ container, root } = createContainer())

    await act(async () => {
      root?.render(
        <BoundaryHarness>
          <LazyRejectingImport />
        </BoundaryHarness>
      )
    })
    await flushReactWork()
    await flushReactWork()

    expect(container?.textContent).toContain('rich markdown editor')
    expect(reportCrashMock).not.toHaveBeenCalled()
    expect(recordBreadcrumbMock).toHaveBeenCalledWith('lazy_chunk_boundary_degraded', {
      boundaryId: 'editor.rich-markdown',
      reloadKey: 'rich-markdown-editor',
      cause: `SyntaxError: ${CORRUPT_CHUNK_PARSE_ERROR}`
    })
  })

  it('records the degraded breadcrumb once across repeated Retry clicks', async () => {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, LANDED_RELOAD_GUARD_VALUE)
    const LazyRejectingImport = lazyWithRetry(
      () => Promise.reject(new SyntaxError(CORRUPT_CHUNK_PARSE_ERROR)),
      { retries: 0 }
    )
    ;({ container, root } = createContainer())

    await act(async () => {
      root?.render(
        <BoundaryHarness>
          <LazyRejectingImport />
        </BoundaryHarness>
      )
    })
    await flushReactWork()
    await flushReactWork()

    for (let click = 0; click < 3; click += 1) {
      const retry = container?.querySelector('button')
      expect(retry).not.toBeNull()
      await act(async () => {
        retry?.click()
      })
      await flushReactWork()
    }

    expect(container?.textContent).toContain('rich markdown editor')
    expect(recordBreadcrumbMock).toHaveBeenCalledTimes(1)
  })

  it('records the degraded breadcrumb once across boundary remounts', async () => {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, LANDED_RELOAD_GUARD_VALUE)
    const LazyRejectingImport = lazyWithRetry(
      () => Promise.reject(new SyntaxError("Unexpected token '<'")),
      { retries: 0 }
    )
    ;({ container, root } = createContainer())

    for (const boundaryKey of ['pane-a', 'pane-b', 'pane-c']) {
      await act(async () => {
        root?.render(
          <BoundaryHarness boundaryKey={boundaryKey}>
            <LazyRejectingImport />
          </BoundaryHarness>
        )
      })
      await flushReactWork()
      await flushReactWork()
    }

    expect(container?.textContent).toContain('rich markdown editor')
    expect(recordBreadcrumbMock).toHaveBeenCalledTimes(1)
  })

  it('still reports ordinary render errors', async () => {
    const error = new Error('ordinary render failure')
    function BrokenEditor(): ReactElement {
      throw error
    }
    ;({ container, root } = createContainer())

    await act(async () => {
      root?.render(
        <BoundaryHarness>
          <BrokenEditor />
        </BoundaryHarness>
      )
    })

    expect(container?.textContent).toContain('rich markdown editor')
    expect(recordBreadcrumbMock).not.toHaveBeenCalled()
    expect(reportCrashMock).toHaveBeenCalledTimes(1)
    expect(reportCrashMock).toHaveBeenCalledWith(
      expect.objectContaining({
        boundaryId: 'editor.rich-markdown',
        surface: 'rich-markdown-editor',
        error
      })
    )
  })
})

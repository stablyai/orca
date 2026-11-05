// @vitest-environment happy-dom

// Contain known chunk failures even if requested reload never navigates; otherwise the surviving boundary receives a raw SyntaxError and files a crash (1.4.171–1.4.175 reports).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isLazyChunkLoadError,
  loadLazyWithRetry,
  resetLazyChunkReloadRequestsForTest
} from './lazy-with-retry'
const RELOAD_SETTLE_GRACE_MS = 10_000

const CORRUPT_CHUNK_ERROR = (): SyntaxError => new SyntaxError("Unexpected token '}'")

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

describe('loadLazyWithRetry when the recovery reload never lands', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    // Reproduce reload requests with no following bootstrap/navigation.
    vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    delete (window as unknown as { api?: unknown }).api
  })

  it('surfaces a recognizable LazyChunkLoadError so the boundary can contain it', async () => {
    const breadcrumbs = installBreadcrumbSink()
    const settled = loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'right-sidebar'
    }).then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const
    )

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(RELOAD_SETTLE_GRACE_MS + 1)

    const result = await settled
    expect(result.ok).toBe(false)

    const vetoed = breadcrumbs.find((crumb) => crumb.name === 'lazy_chunk_reload_vetoed')
    expect(vetoed?.data.outcome).toBe('never-landed')

    // The boundary only suppresses LazyChunkLoadError; a raw SyntaxError files a crash report.
    expect(isLazyChunkLoadError((result as { error: unknown }).error)).toBe(true)
  })

  it('does not strand a sibling lazy import that fails while a reload is pending', async () => {
    installBreadcrumbSink()
    const first = loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'app.root'
    }).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(0)

    // A sibling surface can fail while reload is pending; it must receive containment and an explanatory breadcrumb too.
    const sibling = loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'app.root.sibling'
    }).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(RELOAD_SETTLE_GRACE_MS + 1)

    expect(isLazyChunkLoadError(await first)).toBe(true)
    expect(isLazyChunkLoadError(await sibling)).toBe(true)
  })
})

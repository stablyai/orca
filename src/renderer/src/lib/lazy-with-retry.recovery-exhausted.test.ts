// @vitest-environment happy-dom

// Field gap (bundle F0C17E8TVU0): after the lazy-chunk reload landed, the replacement
// document's chunk failed again and `loadLazyWithRetry` threw straight out of the
// 'reload-landed' branch without a breadcrumb. The bundle therefore ends at
// `lazy_chunk_reload` with no record that renderer-side recovery was already spent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isLazyChunkLoadError,
  loadLazyWithRetry,
  resetLazyChunkReloadRequestsForTest
} from './lazy-with-retry'

const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
const RELOAD_SETTLE_GRACE_MS = 10_000
const FIELD_CHUNK_ERROR = (): Error =>
  new Error('Failed to fetch dynamically imported module: file:///D:/orca/app/chunk.js')

type Breadcrumb = { name: string; data: Record<string, unknown> }

function installBreadcrumbSink(): Breadcrumb[] {
  const breadcrumbs: Breadcrumb[] = []
  Object.assign(window, {
    api: {
      crashReports: {
        recordBreadcrumb: (crumb: Breadcrumb) => {
          breadcrumbs.push(crumb)
        }
      }
    }
  })
  return breadcrumbs
}

describe('loadLazyWithRetry once reload recovery is spent', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    Reflect.deleteProperty(window, 'api')
  })

  it('records that recovery is exhausted in the document a landed reload produced', async () => {
    const breadcrumbs = installBreadcrumbSink()
    // The guard token belongs to the previous document, i.e. the reload really landed.
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, 'previous-document-token')

    await expect(
      loadLazyWithRetry(() => Promise.reject(FIELD_CHUNK_ERROR()), {
        retries: 0,
        reloadKey: 'right-sidebar'
      })
    ).rejects.toSatisfy(isLazyChunkLoadError)

    expect(breadcrumbs).toEqual([
      {
        name: 'lazy_chunk_recovery_exhausted',
        data: expect.objectContaining({ reloadKey: 'right-sidebar', outcome: 'reload-landed' })
      }
    ])
  })

  it('keeps the exhausted record to one entry per document however many call sites fail', async () => {
    const breadcrumbs = installBreadcrumbSink()
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, 'previous-document-token')

    for (const reloadKey of ['right-sidebar', 'diff-view', 'settings']) {
      await expect(
        loadLazyWithRetry(() => Promise.reject(FIELD_CHUNK_ERROR()), { retries: 0, reloadKey })
      ).rejects.toSatisfy(isLazyChunkLoadError)
    }

    // The 30-slot main-process ring is the scarce sink; the fact is the same one three times.
    expect(breadcrumbs).toHaveLength(1)
    expect(breadcrumbs[0]?.data.reloadKey).toBe('right-sidebar')
  })

  it('records the spent per-document reload cap the same way', async () => {
    const breadcrumbs = installBreadcrumbSink()
    // 'not-attempted' guard, but this document already spent its reload requests.
    vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
    vi.useFakeTimers()
    for (let request = 0; request < 2; request += 1) {
      const settled = loadLazyWithRetry(() => Promise.reject(FIELD_CHUNK_ERROR()), {
        retries: 0,
        reloadKey: 'right-sidebar'
      }).catch((error: unknown) => error)
      // Expire the reload settle grace window so the request resolves as 'never-landed'.
      await vi.advanceTimersByTimeAsync(RELOAD_SETTLE_GRACE_MS + 1)
      expect(isLazyChunkLoadError(await settled)).toBe(true)
    }
    vi.useRealTimers()
    breadcrumbs.length = 0

    await expect(
      loadLazyWithRetry(() => Promise.reject(FIELD_CHUNK_ERROR()), {
        retries: 0,
        reloadKey: 'diff-view'
      })
    ).rejects.toSatisfy(isLazyChunkLoadError)

    expect(breadcrumbs).toEqual([
      {
        name: 'lazy_chunk_recovery_exhausted',
        data: expect.objectContaining({ reloadKey: 'diff-view', outcome: 'reload-cap-spent' })
      }
    ])
  })
})

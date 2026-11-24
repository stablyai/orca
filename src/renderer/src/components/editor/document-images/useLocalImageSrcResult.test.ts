// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readLocalImagePreview } from './local-image-src-reader'
import {
  blobUrlCache,
  invalidateLocalImageCache,
  resetLocalImageCacheState
} from './local-image-src-cache'
import { useLocalImageSrcResult } from './useLocalImageSrc'

vi.mock('./local-image-src-reader', () => ({ readLocalImagePreview: vi.fn() }))
vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

type Read = Awaited<ReturnType<typeof readLocalImagePreview>>

afterEach(() => {
  cleanup()
  resetLocalImageCacheState()
  vi.clearAllMocks()
})

/** Reads that fail when told to; the loader turns a failed read into no image. */
function pendingReads(): ((error: Error) => void)[] {
  const fails: ((error: Error) => void)[] = []
  vi.mocked(readLocalImagePreview).mockImplementation(
    () => new Promise<Read>((_, reject) => fails.push(reject))
  )
  return fails
}

it('is loading until its first read settles, then failed when nothing was read', async () => {
  const finishes = pendingReads()
  const { result } = renderHook(() => useLocalImageSrcResult('/tmp/shot.png', '/tmp/shot.png'))
  expect(result.current.status).toBe('loading')

  await act(async () => finishes[0](new Error('unreadable')))
  expect(result.current.status).toBe('failed')
})

it('stays loading when an invalidation supersedes the read in flight', async () => {
  const finishes = pendingReads()
  const { result } = renderHook(() => useLocalImageSrcResult('/tmp/shot.png', '/tmp/shot.png'))
  act(() => invalidateLocalImageCache())

  await act(async () => finishes[0](new Error('unreadable')))
  expect(result.current.status).toBe('loading')
})

it('fails at once when there is nothing to read', () => {
  const { result } = renderHook(() => useLocalImageSrcResult(undefined, ''))
  expect(result.current.status).toBe('failed')
})

/** `a.png` reads at once the first time; every later read waits until the test lets it finish. */
function readsWithPendingRepeat(): void {
  let firstA = true
  vi.mocked(readLocalImagePreview).mockImplementation((path) => {
    if (path.endsWith('a.png') && firstA) {
      firstA = false
      return Promise.resolve({ content: 'AAAA', isBinary: true, mimeType: 'image/png' })
    }
    return new Promise<Read>(() => {})
  })
}

function evict(url: string | undefined): void {
  for (const [key, cached] of blobUrlCache) {
    if (cached === url) {
      blobUrlCache.delete(key)
    }
  }
}

it('is loading, not ready, on returning to an image the cache evicted meanwhile', async () => {
  readsWithPendingRepeat()
  const { result, rerender } = renderHook(({ path }) => useLocalImageSrcResult(path, path), {
    initialProps: { path: '/tmp/a.png' }
  })
  await act(async () => {})
  const shown = result.current.src
  expect(result.current.status).toBe('ready')

  rerender({ path: '/tmp/b.png' })
  evict(shown)
  rerender({ path: '/tmp/a.png' })
  expect(result.current.status).toBe('loading')
})

it('is ready at once on returning to an image the cache still holds', async () => {
  readsWithPendingRepeat()
  const { result, rerender } = renderHook(({ path }) => useLocalImageSrcResult(path, path), {
    initialProps: { path: '/tmp/a.png' }
  })
  await act(async () => {})
  const shown = result.current.src

  rerender({ path: '/tmp/b.png' })
  rerender({ path: '/tmp/a.png' })
  expect(result.current.status).toBe('ready')
  expect(result.current.src).toBe(shown)
})

// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { readLocalImagePreview } from './local-image-src-reader'
import { invalidateLocalImageCache, resetLocalImageCacheState } from './local-image-src-cache'
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

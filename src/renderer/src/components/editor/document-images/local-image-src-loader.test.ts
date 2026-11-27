import { afterEach, expect, it, vi } from 'vitest'
import { readLocalImagePreview } from './local-image-src-reader'
import { invalidateLocalImageCache, resetLocalImageCacheState } from './local-image-src-cache'
import { loadLocalImageAbsolutePath } from './useLocalImageSrc'

vi.mock('./local-image-src-reader', () => ({ readLocalImagePreview: vi.fn() }))
vi.mock('@/diagnostics/crash-reporting/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

afterEach(() => {
  resetLocalImageCacheState()
  vi.restoreAllMocks()
})

it('abandons a read an invalidation supersedes mid-decode, and the reread succeeds', async () => {
  // Two slices of base64, so the decode yields once between them.
  const large = 'A'.repeat(4 * 1024 * 1024 + 4)
  vi.mocked(readLocalImagePreview)
    .mockResolvedValueOnce({ content: large, isBinary: true, mimeType: 'image/png' })
    .mockResolvedValueOnce({ content: 'AAAA', isBinary: true, mimeType: 'image/png' })
  const decode = globalThis.atob
  let invalidated = false
  vi.spyOn(globalThis, 'atob').mockImplementation((text) => {
    if (!invalidated) {
      invalidated = true
      invalidateLocalImageCache()
    }
    return decode(text)
  })
  const created = vi.spyOn(URL, 'createObjectURL')

  expect(await loadLocalImageAbsolutePath('/tmp/shot.png')).toBeNull()
  expect(created).not.toHaveBeenCalled()

  expect(await loadLocalImageAbsolutePath('/tmp/shot.png')).toMatch(/^blob:/)
})

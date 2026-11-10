// @vitest-environment happy-dom

import 'react'
import 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadLocalImageSrc } from './useLocalImageSrc'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  resetLocalImageCacheState as resetLocalImageSrcStateForTests
} from './local-image-src-cache'

import { pinLocalImageCacheKey as pinLocalImageCache } from './local-image-cache-pinning'
import {
  holdBrowserAttachmentFiles,
  readBrowserAttachmentFile,
  releaseBrowserAttachmentFiles
} from '@/lib/files/drop/browser-attachment-files'

function setReadFile(readFile: ReturnType<typeof vi.fn>): void {
  globalThis.window.api = {
    fs: { readFile }
  } as unknown as Window['api']
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  vi.spyOn(URL, 'createObjectURL').mockReset()
  vi.spyOn(URL, 'revokeObjectURL').mockReset()
})

afterEach(() => {
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
})

describe('loadLocalImageSrc', () => {
  it('previews a staged browser image before a workspace exists without consuming its upload file', async () => {
    const readFile = vi.fn(() => {
      throw new Error('Runtime files are unavailable before workspace creation')
    })
    const file = new File(['image bytes'], 'screenshot.png', { type: 'image/png' })
    const [token] = holdBrowserAttachmentFiles([file])
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:staged-image')
    setReadFile(readFile)

    try {
      await expect(loadLocalImageSrc(token, '', undefined, null)).resolves.toBe('blob:staged-image')
      expect(readBrowserAttachmentFile(token)).toBe(file)
    } finally {
      releaseBrowserAttachmentFiles([token])
    }
  })

  it('does not exceed the decoded-byte budget when all retained entries are pinned', () => {
    const retainedBytes = 80 * 1024 * 1024
    pinLocalImageCache('large-pinned-1')
    pinLocalImageCache('large-pinned-2')
    expect(cacheLocalImageBlob('large-pinned-1', 'blob:large-1', retainedBytes)).toBe(true)
    expect(cacheLocalImageBlob('large-pinned-2', 'blob:large-2', retainedBytes)).toBe(false)

    expect(blobUrlCache.size).toBe(1)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:large-2')
  })
})

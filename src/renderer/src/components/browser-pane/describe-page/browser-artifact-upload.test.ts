// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ARTIFACT_MAX_CONTENT_BYTES } from '../../../../../shared/artifacts'
import type { ArtifactPublishPreparationError } from '@/components/artifacts/artifact-publish-flow'
import {
  getShareableBrowserArtifactFile,
  readBrowserHtmlArtifactRequest
} from './browser-artifact-upload'

const stat = vi.fn()
const readFile = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  window.api = { fs: { stat, readFile } } as never
  stat.mockResolvedValue({ size: 20, isDirectory: false, mtime: 1 })
  readFile.mockResolvedValue({ content: '<h1>Mock</h1>', isBinary: false })
})

describe('browser artifact upload', () => {
  it('recognizes local HTML URLs across path flavors', () => {
    expect(getShareableBrowserArtifactFile('file:///tmp/Design%20Review.html')).toEqual({
      fileName: 'Design Review.html',
      filePath: '/tmp/Design Review.html'
    })
    expect(getShareableBrowserArtifactFile('file:///C:/repo/report.HTM')).toEqual({
      fileName: 'report.HTM',
      filePath: 'C:\\repo\\report.HTM'
    })
    expect(getShareableBrowserArtifactFile('file://server/share/report.html')).toEqual({
      fileName: 'report.html',
      filePath: '\\\\server\\share\\report.html'
    })
    expect(getShareableBrowserArtifactFile('https://example.com/report.html')).toBeNull()
    expect(getShareableBrowserArtifactFile('file:///tmp/report.md')).toBeNull()
  })

  it('reads the backing file through the authorized filesystem API', async () => {
    await expect(readBrowserHtmlArtifactRequest('file:///tmp/report.html')).resolves.toEqual({
      sourceKey: '/tmp/report.html',
      content: '<h1>Mock</h1>',
      contentType: 'text/html',
      fileName: 'report.html'
    })
    expect(stat).toHaveBeenCalledWith({ filePath: '/tmp/report.html' })
    expect(readFile).toHaveBeenCalledWith({ filePath: '/tmp/report.html' })
  })

  it('rejects oversized and unreadable files before upload', async () => {
    stat.mockResolvedValueOnce({
      size: ARTIFACT_MAX_CONTENT_BYTES + 1,
      isDirectory: false,
      mtime: 1
    })
    await expect(readBrowserHtmlArtifactRequest('file:///tmp/large.html')).rejects.toMatchObject({
      code: 'too-large'
    } satisfies Partial<ArtifactPublishPreparationError>)
    expect(readFile).not.toHaveBeenCalled()

    stat.mockRejectedValueOnce(new Error('access denied'))
    await expect(readBrowserHtmlArtifactRequest('file:///tmp/private.html')).rejects.toMatchObject({
      code: 'unreadable'
    } satisfies Partial<ArtifactPublishPreparationError>)
  })

  it('accepts a file whose stat is exactly at the 10 MiB boundary', async () => {
    stat.mockResolvedValueOnce({
      size: ARTIFACT_MAX_CONTENT_BYTES,
      isDirectory: false,
      mtime: 1
    })

    await expect(readBrowserHtmlArtifactRequest('file:///tmp/exact.html')).resolves.toMatchObject({
      sourceKey: '/tmp/exact.html'
    })
  })
})

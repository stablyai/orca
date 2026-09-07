import { describe, expect, it } from 'vitest'
import {
  formatBrowserDownloadProgress,
  type BrowserDownloadState
} from './browser-download-progress'

function download(overrides: Partial<BrowserDownloadState> = {}): BrowserDownloadState {
  return {
    downloadId: 'd1',
    browserPageId: 'p1',
    filename: 'file.bin',
    mimeType: 'application/octet-stream',
    origin: 'https://example.com',
    totalBytes: 2048,
    receivedBytes: 1024,
    status: 'downloading',
    savePath: null,
    error: null,
    progressState: 'progressing',
    completedAt: null,
    url: 'https://example.com/file.bin',
    ...overrides
  } as BrowserDownloadState
}

describe('formatBrowserDownloadProgress', () => {
  it('joins received and total when both are known', () => {
    expect(formatBrowserDownloadProgress(download())).toBe('1.0 KB / 2.0 KB')
  })

  it('falls back to the single known side', () => {
    expect(formatBrowserDownloadProgress(download({ totalBytes: null }))).toBe('1.0 KB')
    expect(formatBrowserDownloadProgress(download({ receivedBytes: -1, totalBytes: 2048 }))).toBe(
      '2.0 KB'
    )
  })
})

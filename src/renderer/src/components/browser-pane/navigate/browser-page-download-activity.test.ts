import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DownloadRequestedCallback = (event: { downloadId: string; browserPageId: string }) => void
type DownloadFinishedCallback = (event: { downloadId: string }) => void

describe('browser page download activity', () => {
  let requestedCallbacks: DownloadRequestedCallback[]
  let finishedCallbacks: DownloadFinishedCallback[]
  let removedListenerCount: number

  beforeEach(() => {
    vi.resetModules()
    requestedCallbacks = []
    finishedCallbacks = []
    removedListenerCount = 0
    const removeListener = (): void => {
      removedListenerCount += 1
    }
    vi.stubGlobal('window', {
      api: {
        browser: {
          onDownloadRequested: (callback: DownloadRequestedCallback) => {
            requestedCallbacks.push(callback)
            return removeListener
          },
          onDownloadFinished: (callback: DownloadFinishedCallback) => {
            finishedCallbacks.push(callback)
            return removeListener
          }
        }
      }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports a page active from download start until its last download finishes', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    installBrowserPageDownloadActivityTracking()

    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    requestedCallbacks[0]({ downloadId: 'dl-2', browserPageId: 'page-1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)

    finishedCallbacks[0]({ downloadId: 'dl-1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)
    finishedCallbacks[0]({ downloadId: 'dl-2' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
  })

  it('scopes activity to the page that started the download', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    installBrowserPageDownloadActivityTracking()

    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    expect(hasActiveBrowserPageDownload('page-2')).toBe(false)
  })

  it('ignores duplicate start events and unknown finish events', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    installBrowserPageDownloadActivityTracking()

    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    finishedCallbacks[0]({ downloadId: 'dl-unknown' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)
    finishedCallbacks[0]({ downloadId: 'dl-1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
  })

  it('unsubscribes and clears tracked state on cleanup', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    const cleanup = installBrowserPageDownloadActivityTracking()

    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    cleanup()

    expect(removedListenerCount).toBe(2)
    // A host remount tears down every guest; stale entries must not veto eviction.
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
  })
})

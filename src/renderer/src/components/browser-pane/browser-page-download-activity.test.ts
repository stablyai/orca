import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type DownloadRequestedCallback = (event: { downloadId: string; browserPageId: string }) => void
type DownloadProgressCallback = (event: {
  downloadId: string
  state: 'progressing' | 'interrupted' | null
}) => void
type DownloadFinishedCallback = (event: { downloadId: string }) => void

describe('browser page download activity', () => {
  let requestedCallbacks: DownloadRequestedCallback[]
  let progressCallbacks: DownloadProgressCallback[]
  let finishedCallbacks: DownloadFinishedCallback[]
  let removedListenerCount: number

  beforeEach(() => {
    vi.resetModules()
    requestedCallbacks = []
    progressCallbacks = []
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
          onDownloadProgress: (callback: DownloadProgressCallback) => {
            progressCallbacks.push(callback)
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

  it('deactivates an interrupted download (no finished event ever fires) and reactivates on resume', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    installBrowserPageDownloadActivityTracking()

    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    progressCallbacks[0]({ downloadId: 'dl-1', state: 'interrupted' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)

    progressCallbacks[0]({ downloadId: 'dl-1', state: 'progressing' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)

    // A null state is transport noise, not a transition.
    progressCallbacks[0]({ downloadId: 'dl-1', state: null })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)

    finishedCallbacks[0]({ downloadId: 'dl-1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
  })

  it('ignores duplicate start events, unknown progress and unknown finish events', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    installBrowserPageDownloadActivityTracking()

    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    progressCallbacks[0]({ downloadId: 'dl-unknown', state: 'interrupted' })
    finishedCallbacks[0]({ downloadId: 'dl-unknown' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)
    finishedCallbacks[0]({ downloadId: 'dl-1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
  })

  it('finishing an already-interrupted download stays balanced', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    installBrowserPageDownloadActivityTracking()

    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    requestedCallbacks[0]({ downloadId: 'dl-2', browserPageId: 'page-1' })
    progressCallbacks[0]({ downloadId: 'dl-1', state: 'interrupted' })
    finishedCallbacks[0]({ downloadId: 'dl-1' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(true)
    finishedCallbacks[0]({ downloadId: 'dl-2' })
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
  })

  it('unsubscribes and clears tracked state on cleanup', async () => {
    const { hasActiveBrowserPageDownload, installBrowserPageDownloadActivityTracking } =
      await import('./browser-page-download-activity')
    const cleanup = installBrowserPageDownloadActivityTracking()

    requestedCallbacks[0]({ downloadId: 'dl-1', browserPageId: 'page-1' })
    cleanup()

    expect(removedListenerCount).toBe(3)
    // A host remount tears down every guest; stale entries must not veto eviction.
    expect(hasActiveBrowserPageDownload('page-1')).toBe(false)
  })
})

// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastMocks = vi.hoisted(() => ({
  loading: vi.fn(),
  success: vi.fn(),
  error: vi.fn()
}))

vi.mock('sonner', () => ({ toast: toastMocks }))

const store = vi.hoisted(() => {
  const remoteBrowserPageHandlesByPageId: Record<string, unknown> = {}
  return { state: { remoteBrowserPageHandlesByPageId } }
})
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))

import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent
} from '../../../../shared/browser-guest-events'
import { paneChannel } from './client-hosted-browser-pane-test-rig'
import { useBrowserClientHostedDownloadNotices } from './browser-client-hosted-download-notices'

let requested = paneChannel<BrowserDownloadRequestedEvent>()
let progress = paneChannel<BrowserDownloadProgressEvent>()
let finished = paneChannel<BrowserDownloadFinishedEvent>()

beforeEach(() => {
  requested = paneChannel<BrowserDownloadRequestedEvent>()
  progress = paneChannel<BrowserDownloadProgressEvent>()
  finished = paneChannel<BrowserDownloadFinishedEvent>()
  store.state.remoteBrowserPageHandlesByPageId = {
    'page-a': {
      environmentId: 'environment-a',
      remotePageId: 'remote-page-a',
      placement: { kind: 'client' }
    }
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onDownloadRequested: requested.subscribe,
        onDownloadProgress: progress.subscribe,
        onDownloadFinished: finished.subscribe
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function renderNotices(): void {
  renderHook(useBrowserClientHostedDownloadNotices)
}

function emitRequested(overrides: Partial<BrowserDownloadRequestedEvent> = {}): void {
  const event = {
    browserPageId: 'page-a',
    downloadId: 'download-1',
    origin: 'https://example.internal',
    filename: 'report.pdf',
    totalBytes: 1024,
    mimeType: 'application/pdf',
    savePath: '/tmp/staging/download',
    status: 'downloading',
    ...overrides
  } as BrowserDownloadRequestedEvent
  act(() => requested.emit(event))
}

function emitFinished(overrides: Partial<BrowserDownloadFinishedEvent> = {}): void {
  const event = {
    browserPageId: 'page-a',
    downloadId: 'download-1',
    status: 'completed',
    savePath: null,
    error: null,
    ...overrides
  } as BrowserDownloadFinishedEvent
  act(() => finished.emit(event))
}

function emitProgress(overrides: Partial<BrowserDownloadProgressEvent> = {}): void {
  const event = {
    downloadId: 'download-1',
    receivedBytes: 2_202_009,
    totalBytes: 8_388_608,
    state: 'progressing',
    ...overrides
  } as BrowserDownloadProgressEvent
  act(() => progress.emit(event))
}

describe('client-hosted browser download notices', () => {
  it('names the remote workspace destination when the download lands there', () => {
    renderNotices()

    emitRequested()
    expect(toastMocks.loading).toHaveBeenCalledWith('Downloading report.pdf…', {
      id: 'browser-download:download-1'
    })

    emitFinished({
      remoteDestination: {
        workspaceRelativePath: '.orca/browser-downloads/report.pdf',
        hostLabel: 'build-box'
      }
    })

    expect(toastMocks.success).toHaveBeenCalledWith(
      'Saved to .orca/browser-downloads/report.pdf on build-box',
      { id: 'browser-download:download-1' }
    )
  })

  it('surfaces the fail-closed remote error instead of dropping it', () => {
    renderNotices()
    emitRequested()

    emitFinished({
      status: 'failed',
      error: 'Could not save the download to the remote workspace.'
    })

    expect(toastMocks.error).toHaveBeenCalledWith(
      'Could not save the download to the remote workspace.',
      { id: 'browser-download:download-1' }
    )
  })

  // Why: the page's pane unmounts on a page switch or close while its download keeps running, and
  // an unsettled loading toast has no close button.
  it('settles the toast after the page that started the download is gone', () => {
    renderNotices()
    emitRequested()
    store.state.remoteBrowserPageHandlesByPageId = {}

    emitFinished({ status: 'canceled' })

    expect(toastMocks.error).toHaveBeenCalledWith('Download canceled.', {
      id: 'browser-download:download-1'
    })
  })

  it('leaves downloads from pages this desktop does not host to their own shelf', () => {
    renderNotices()

    emitRequested({ browserPageId: 'local-page', downloadId: 'download-2' })
    emitFinished({ browserPageId: 'local-page', downloadId: 'download-2' })

    expect(toastMocks.loading).not.toHaveBeenCalled()
    expect(toastMocks.success).not.toHaveBeenCalled()
  })

  // Why: bytes for a client-hosted page land on the remote workspace, so this toast is the only
  // place a long download shows any movement at all.
  it('moves the toast forward as bytes arrive', () => {
    renderNotices()
    emitRequested()
    toastMocks.loading.mockClear()

    emitProgress()

    expect(toastMocks.loading).toHaveBeenCalledWith('Downloading report.pdf… 2.1 MB / 8.0 MB', {
      id: 'browser-download:download-1'
    })
  })

  it('ignores progress for a download it never claimed', () => {
    renderNotices()
    toastMocks.loading.mockClear()

    emitProgress()

    expect(toastMocks.loading).not.toHaveBeenCalled()
  })
})

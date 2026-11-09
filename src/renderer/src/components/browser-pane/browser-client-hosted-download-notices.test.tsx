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
} from '../../../../shared/browser/guest-lifecycle/browser-guest-events'
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

describe('client-hosted browser download notices', () => {
  // Downloads outlive their panes; an unsettled loading toast has no close button.
  it('settles the toast after the page that started the download is gone', () => {
    renderNotices()
    emitRequested()
    store.state.remoteBrowserPageHandlesByPageId = {}

    emitFinished({ status: 'canceled' })

    expect(toastMocks.error).toHaveBeenCalledWith('Download canceled.', {
      id: 'browser-download:download-1'
    })
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { hydrateBrowserRemoteViewerPages } from '../../../runtime/browser/ownership/browser-remote-viewer-store'
import { browserGuestActivity, setBrowserGuestVisible } from './browser-guest-activity'
import { registerPersistentWebview, unregisterPersistentWebview } from './webview-registry'
import { useTerminalBrowserRetention } from '../../use-terminal-browser-retention'
import type { BrowserGuestIdleDiscardRequest } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

const state = vi.hoisted(() => ({ browserAudiblePageIds: {} }))
vi.mock('../../../store', () => ({ useAppStore: { getState: () => state } }))

function Host(): null {
  useTerminalBrowserRetention()
  return null
}

async function fixture() {
  let requested: (event: { downloadId: string; browserPageId: string }) => void = () => {}
  let finished: (event: { downloadId: string }) => void = () => {}
  let due: (request: BrowserGuestIdleDiscardRequest) => void = () => {}
  const browser = {
    reportGuestVisibility: () => {},
    onGuestIdleDiscardDue: (callback: typeof due) => {
      due = callback
      return () => {}
    },
    refuseGuestIdleDiscard: () => {},
    onDownloadRequested: (callback: typeof requested) => {
      requested = callback
      return () => {}
    },
    onDownloadFinished: (callback: typeof finished) => {
      finished = callback
      return () => {}
    },
    onAudioStateChanged: () => () => {},
    onGuestDiscardProtectionChanged: () => () => {},
    unregisterGuest: async () => {},
    reserveGuestDiscard: vi.fn(
      (_request: { browserPageId: string; webContentsId: number }) => true
    ),
    acknowledgeGuestRemoval: async () => true
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { browser } })
  const container = document.createElement('div')
  const root = createRoot(container)
  const guests = document.body.appendChild(document.createElement('div'))
  const webviews = new Map<number, HTMLDivElement>()
  const addGuest = (id: number): void => {
    const webview = guests.appendChild(document.createElement('div'))
    webviews.set(id, webview)
    Object.defineProperty(webview, 'getWebContentsId', { value: () => id })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: DOM fixture implements the native identity method and real removal/listener surface.
    registerPersistentWebview(`page-${id}`, webview as unknown as Electron.WebviewTag)
    setBrowserGuestVisible(`page-${id}`, false)
  }
  const render = async (): Promise<void> => {
    await act(async () => root.render(<Host />))
  }
  const run = async (action: () => void): Promise<void> => {
    await act(async () => action())
  }
  return {
    addGuest,
    due: (id: number) =>
      due({
        browserPageId: `page-${id}`,
        webContentsId: id,
        visible: false,
        generation: browserGuestActivity.get(`page-${id}`)!.visibilityGeneration,
        policyToken: {
          rendererId: 99,
          generation: browserGuestActivity.get(`page-${id}`)!.visibilityGeneration
        }
      }),
    render,
    run,
    webviews,
    reserve: browser.reserveGuestDiscard,
    startDownload: () => requested({ downloadId: 'download', browserPageId: 'page-1' }),
    finishDownload: () => finished({ downloadId: 'download' }),
    async close() {
      await act(async () => root.unmount())
      hydrateBrowserRemoteViewerPages([])
      for (const id of webviews.keys()) {
        unregisterPersistentWebview(`page-${id}`)
      }
      guests.remove()
      Reflect.deleteProperty(window, 'api')
    }
  }
}

afterEach(() => vi.useRealTimers())

it('protects downloads and paired viewers at a due attempt, without retrying on release', async () => {
  const f = await fixture()
  try {
    await f.render()
    f.addGuest(1)
    f.addGuest(2)
    f.addGuest(3)
    f.startDownload()
    hydrateBrowserRemoteViewerPages(['page-2'])
    await f.run(() => {
      f.due(1)
      f.due(2)
      f.due(3)
    })
    expect(f.webviews.get(1)?.isConnected).toBe(true)
    expect(f.webviews.get(2)?.isConnected).toBe(true)
    expect(f.webviews.get(3)?.isConnected).toBe(false)
    await f.run(f.finishDownload)
    await f.run(() => hydrateBrowserRemoteViewerPages([]))
    expect(f.webviews.get(1)?.isConnected).toBe(true)
    expect(f.webviews.get(2)?.isConnected).toBe(true)
    expect(f.reserve).toHaveBeenCalledTimes(1)
  } finally {
    await f.close()
  }
})

it('protects a page that became active before its due attempt', async () => {
  const f = await fixture()
  try {
    await f.render()
    f.addGuest(1)
    setBrowserGuestVisible('page-1', true)
    await f.run(() => f.due(1))
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.webviews.get(1)?.isConnected).toBe(true)
  } finally {
    await f.close()
  }
})

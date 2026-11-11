// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { hydrateBrowserRemoteViewerPages } from '../../../runtime/browser/ownership/browser-remote-viewer-store'
import { invalidateBrowserGuestActivity, setBrowserGuestVisible } from './browser-guest-activity'
import { registerPersistentWebview, unregisterPersistentWebview } from './webview-registry'
import { useTerminalBrowserRetention } from '../../use-terminal-browser-retention'

const state = vi.hoisted(() => ({
  settings: { browserGuestWorktreeRetentionBudget: false },
  browserAudiblePageIds: {}
}))
vi.mock('../../../store', () => ({ useAppStore: { getState: () => state } }))

function Host({ enabled }: { enabled: boolean }): null {
  useTerminalBrowserRetention({ browserGuestRetentionBudgetEnabled: enabled })
  return null
}

async function fixture() {
  let requested: (event: { downloadId: string; browserPageId: string }) => void = () => {}
  let finished: (event: { downloadId: string }) => void = () => {}
  const browser = {
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
  const render = async (enabled: boolean): Promise<void> => {
    state.settings.browserGuestWorktreeRetentionBudget = enabled
    await act(async () => root.render(<Host enabled={enabled} />))
  }
  const run = async (action: () => void): Promise<void> => {
    await act(async () => action())
  }
  return {
    addGuest,
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

it('keeps downloads and paired viewers protected across retention toggles, without protecting idle siblings', async () => {
  const f = await fixture()
  try {
    await f.render(false)
    for (let id = 1; id <= 33; id++) {
      f.addGuest(id)
    }
    f.startDownload()
    hydrateBrowserRemoteViewerPages(['page-2'])
    await f.render(true)
    await vi.waitFor(() => expect(f.webviews.get(3)?.isConnected).toBe(false))
    await f.render(false)
    await f.render(true)
    for (let id = 34; id <= 66; id++) {
      f.addGuest(id)
    }
    await vi.waitFor(() => expect(f.webviews.get(7)?.isConnected).toBe(false))
    expect(f.webviews.get(1)?.isConnected).toBe(true)
    expect(f.webviews.get(2)?.isConnected).toBe(true)
    f.finishDownload()
    for (let id = 67; id <= 99; id++) {
      f.addGuest(id)
    }
    await vi.waitFor(() => expect(f.webviews.get(1)?.isConnected).toBe(false))
    hydrateBrowserRemoteViewerPages([])
    for (let id = 100; id <= 132; id++) {
      f.addGuest(id)
    }
    await vi.waitFor(() => expect(f.webviews.get(2)?.isConnected).toBe(false))
  } finally {
    await f.close()
  }
})

it.each(['release', 'use', 'refusal', 'reinstall'])(
  'retains canonical oldest-eligible order through download %s',
  async (mode) => {
    const f = await fixture()
    try {
      await f.render(false)
      for (let id = 1; id <= 32; id++) {
        f.addGuest(id)
      }
      f.startDownload()
      await f.render(true)
      expect(f.reserve).not.toHaveBeenCalled()
      await f.run(f.finishDownload)
      expect(f.reserve).not.toHaveBeenCalled()
      if (mode === 'use') {
        await f.run(() => {
          setBrowserGuestVisible('page-1', true)
          setBrowserGuestVisible('page-1', false)
        })
      }
      if (mode === 'reinstall') {
        await f.render(false)
        await f.render(true)
      }
      if (mode === 'refusal') {
        f.reserve.mockReturnValue(false)
      }
      await f.run(() => f.addGuest(33))
      expect(f.reserve.mock.calls[0]?.[0]).toEqual({
        browserPageId: mode === 'use' ? 'page-2' : 'page-1',
        webContentsId: mode === 'use' ? 2 : 1
      })
      if (mode === 'refusal') {
        f.reserve.mockClear()
        f.reserve.mockReturnValue(true)
        await f.run(() => invalidateBrowserGuestActivity('page-1'))
        expect(f.reserve.mock.calls[0]?.[0]).toEqual({ browserPageId: 'page-1', webContentsId: 1 })
        expect(f.webviews.get(1)?.isConnected).toBe(false)
      }
    } finally {
      await f.close()
    }
  }
)

it.each(['pressure', 'reinstall', 'deadline', 'no-pressure'])(
  'uses the original recent-selection deadline after download re-entry: %s',
  async (mode) => {
    vi.useFakeTimers()
    const epoch = 3 * 60 * 60_000
    const minute = 60_000
    vi.setSystemTime(epoch)
    const f = await fixture()
    const select = (id: number): void => {
      setBrowserGuestVisible(`page-${id}`, true)
      setBrowserGuestVisible(`page-${id}`, false)
    }
    try {
      await f.render(false)
      for (let id = 1; id <= 32; id++) {
        f.addGuest(id)
      }
      select(1)
      vi.setSystemTime(epoch + minute)
      f.startDownload()
      vi.setSystemTime(epoch + 10 * minute)
      for (let id = 2; id <= 32; id++) {
        select(id)
      }
      await f.render(true)
      vi.setSystemTime(epoch + 20 * minute)
      await f.run(f.finishDownload)
      if (mode === 'reinstall') {
        await f.render(false)
        await f.render(true)
      }
      expect(f.reserve).not.toHaveBeenCalled()
      if (mode === 'pressure' || mode === 'reinstall') {
        vi.setSystemTime(epoch + 31 * minute)
        await f.run(() => f.addGuest(33))
      } else {
        if (mode === 'deadline') {
          await f.run(() => {
            f.addGuest(33)
            select(33)
          })
          expect(f.reserve).not.toHaveBeenCalled()
        }
        await act(async () => vi.advanceTimersByTimeAsync(10 * minute))
      }
      if (mode === 'no-pressure') {
        expect(f.reserve).not.toHaveBeenCalled()
      } else {
        expect(f.reserve.mock.calls[0]?.[0]).toEqual({ browserPageId: 'page-1', webContentsId: 1 })
        expect(f.webviews.get(1)?.isConnected).toBe(false)
      }
      expect(f.webviews.get(2)?.isConnected).toBe(true)
    } finally {
      await f.close()
    }
  }
)

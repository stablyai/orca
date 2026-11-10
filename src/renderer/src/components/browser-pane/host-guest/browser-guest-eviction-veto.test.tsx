// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { hydrateBrowserRemoteViewerPages } from '../../../lib/pane-manager/browser-remote-viewer-state'
import { setBrowserGuestVisible, browserGuestActivity } from './browser-guest-activity'
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

it('keeps downloads and paired viewers protected across retention toggles, without protecting idle siblings', async () => {
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
    getGuestDiscardProtection: async ({ webContentsId }: { webContentsId: number }) => ({
      webContentsId,
      protection: 'discardable',
      reason: 'clean'
    })
  }
  Object.defineProperty(window, 'api', { configurable: true, value: { browser } })
  const container = document.createElement('div')
  const root = createRoot(container)
  const render = async (enabled: boolean): Promise<void> => {
    state.settings.browserGuestWorktreeRetentionBudget = enabled
    await act(async () => root.render(<Host enabled={enabled} />))
  }
  try {
    await render(false)
    for (let id = 1; id <= 23; id++) {
      const webview = document.createElement('div')
      Object.defineProperty(webview, 'getWebContentsId', { value: () => id })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The DOM element supplies registry listeners/style/removal and the injected guest identity method.
      registerPersistentWebview(`page-${id}`, webview as unknown as Electron.WebviewTag)
      setBrowserGuestVisible(`page-${id}`, false)
    }
    requested({ downloadId: 'download', browserPageId: 'page-1' })
    hydrateBrowserRemoteViewerPages(['page-2'])
    await render(true)
    await vi.waitFor(() => expect(browserGuestActivity.size).toBe(22))
    expect(browserGuestActivity.has('page-3')).toBe(false)
    await render(false)
    await render(true)
    expect(browserGuestActivity.has('page-1')).toBe(true)
    expect(browserGuestActivity.has('page-2')).toBe(true)
    finished({ downloadId: 'download' })
    await vi.waitFor(() => expect(browserGuestActivity.has('page-1')).toBe(false))
    hydrateBrowserRemoteViewerPages([])
    await vi.waitFor(() => expect(browserGuestActivity.size).toBe(20))
  } finally {
    await act(async () => root.unmount())
    hydrateBrowserRemoteViewerPages([])
    for (const id of browserGuestActivity.keys()) {
      unregisterPersistentWebview(id)
    }
    Reflect.deleteProperty(window, 'api')
  }
})

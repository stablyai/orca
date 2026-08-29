import type { PreloadApi } from '../../../preload/api-types'
import { withFallback } from '../web/preload-api/web-fallback-api'
import { createWebPreloadApi } from '../web/web-preload-api'
import { connectDesktopHostBridge, type DesktopHostBridge } from './desktop-host-bridge'
import { createDesktopPtyApi } from './desktop-pty-api'
import { createDesktopWindowControls } from './desktop-window-api'

export async function installDesktopPreloadApi(
  bridge?: DesktopHostBridge
): Promise<DesktopHostBridge> {
  const connected = bridge ?? (await connectDesktopHostBridge())
  const windowControls = createDesktopWindowControls()
  const api = createWebPreloadApi()
  const webApp = api.app as PreloadApi['app']
  const webUi = api.ui as PreloadApi['ui']
  const webPlatform = api.platform as PreloadApi['platform']

  api.app = {
    ...webApp,
    getIdentity: async () => ({
      name: 'Orca',
      isDev: import.meta.env.DEV,
      devLabel: 'Tauri',
      devBranch: null,
      devWorktreeName: null,
      devRepoRoot: null,
      dockBadgeLabel: null
    }),
    awaitFirstWindowStartupServices: async () => undefined,
    relaunch: async () => {
      window.location.reload()
    },
    restart: async () => {
      window.location.reload()
    },
    reload: async () => {
      window.location.reload()
    }
  }

  api.ui = {
    ...webUi,
    ...windowControls
  }

  api.platform = {
    get: () => ({
      ...webPlatform.get(),
      platform: connected.info.platform
    })
  }

  api.pty = createDesktopPtyApi(connected)

  const desktopWindow = window as unknown as {
    __ORCA_TAURI_DESKTOP__?: boolean
    __ORCA_WEB_CLIENT__?: boolean
  }
  desktopWindow.__ORCA_TAURI_DESKTOP__ = true
  desktopWindow.__ORCA_WEB_CLIENT__ = false
  window.api = withFallback(api, []) as PreloadApi
  return connected
}

import { invokeNative, invokePlugin, isTauriNativeHost, listenNative } from './tauri-native-host'
import { translate } from '../i18n/i18n'

// Why: the native close handler cannot read the renderer settings store on
// Alt+F4 or the OS X button, so the renderer pushes minimizeToTrayOnClose
// into Rust state on startup and on every save. This mirrors Electron
// hideToTrayIfEnabled, which reads the setting synchronously in main.
export async function syncTauriMinimizeToTray(enabled: boolean): Promise<void> {
  if (!isTauriNativeHost()) {
    return
  }
  await invokeNative('poc_set_minimize_to_tray', { enabled }).catch(() => {})
}

const EVENT_MINIMIZED_TO_TRAY = 'window:minimized-to-tray'

let trayMinimizeNoticeInstalled = false

// Shared one-shot notice for both minimize-to-tray paths: the renderer-drawn
// X calls this directly, and the native Alt+F4 path reaches it through the
// Rust-emitted event below. The persisted flag keeps it to the first time.
export async function notifyMinimizedToTrayOnce(): Promise<void> {
  const ui = await window.api.ui.get().catch(() => null)
  if (ui?.trayMinimizeNoticeShown === true) {
    return
  }
  await invokePlugin('notification', 'notify', {
    options: {
      title: translate('tray.minimizeNotice.title', 'Orca'),
      body: translate('tray.minimizeNotice.body', 'Orca is still running in the system tray')
    }
  }).catch(() => {})
  await window.api.ui.set({ trayMinimizeNoticeShown: true }).catch(() => {})
}

export function installTauriMinimizeToTrayNotice(): () => void {
  if (trayMinimizeNoticeInstalled) {
    return () => {}
  }
  trayMinimizeNoticeInstalled = true
  return listenNative<void>(EVENT_MINIMIZED_TO_TRAY, () => {
    void notifyMinimizedToTrayOnce()
  })
}

export function resetTauriMinimizeToTrayNoticeForTest(): void {
  trayMinimizeNoticeInstalled = false
}

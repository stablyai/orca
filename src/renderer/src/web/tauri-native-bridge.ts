import { invokeNative, isTauriNativeHost } from './tauri-native-host'
import { createTauriNativeRepositoriesApi } from './tauri-native-repositories-api'
import {
  createTauriNativeAppNamespaceApi,
  createTauriNativePlatformNamespaceApi
} from './tauri-native-platform-app-api'
import { createTauriNativeShellApi } from './tauri-native-shell-api'
import { createTauriNativeCliApi } from './tauri-native-cli-api'
import { createTauriNativeUiApi } from './tauri-native-ui-api'
import { createTauriNativeSettingsApi } from './tauri-native-settings-api'
import { createTauriNativeBrowserApi } from './tauri-native-browser-api'

export { createTauriNativeFilesystemDropApi } from './tauri-native-filesystem-drop-api'
export { createTauriNativeFilesystemApi } from './tauri-native-filesystem-api'
export { createTauriNativeGitApi } from './tauri-native-git-api'
export { isTauriNativeHost } from './tauri-native-host'
export { createTauriNativeRepositoriesApi } from './tauri-native-repositories-api'
export {
  createTauriNativeAppNamespaceApi,
  createTauriNativeAppApi,
  createTauriNativePlatformNamespaceApi,
  createTauriNativePlatformApi
} from './tauri-native-platform-app-api'
export { createTauriNativeShellApi } from './tauri-native-shell-api'
export { createTauriNativeCliApi } from './tauri-native-cli-api'
export { createTauriNativeSettingsApi } from './tauri-native-settings-api'
export {
  createTauriNativeBrowserWebview,
  hasTauriNativeBrowserPage,
  removeTauriNativeBrowserPage,
  syncTauriNativeBrowserWebviewBounds,
  setTauriNativeBrowserWebviewVisible
} from './tauri-native-browser-webview'
export { createTauriNativeBrowserApi } from './tauri-native-browser-api'
export {
  installTauriBrowserGuestCtrlTabCommit,
  installTauriBrowserGuestShortcutForwarding
} from './tauri-native-browser-guest-shortcut'
export { createTauriNativeUiApi } from './tauri-native-ui-api'

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'])

function isElectronStyleDragRegion(path: EventTarget[]): boolean {
  for (const target of path) {
    if (!(target instanceof HTMLElement)) {
      continue
    }
    const region = getComputedStyle(target).getPropertyValue('-webkit-app-region').trim()
    if (region === 'no-drag') {
      return false
    }
    if (region === 'drag') {
      return !INTERACTIVE_TAGS.has(target.tagName)
    }
  }
  return false
}

export function installTauriWindowDragBridge(): void {
  if (
    !isTauriNativeHost() ||
    (!navigator.userAgent.includes('Windows') && !navigator.userAgent.includes('Linux'))
  ) {
    return
  }
  document.addEventListener(
    'mousedown',
    (event) => {
      if (event.button !== 0 || event.detail !== 1) {
        return
      }
      if (!isElectronStyleDragRegion(event.composedPath())) {
        return
      }
      event.preventDefault()
      event.stopImmediatePropagation()
      void invokeNative('plugin:window|start_dragging')
    },
    true
  )
}

export function createTauriNativePreloadApi(): {
  shell?: ReturnType<typeof createTauriNativeShellApi>
  ui?: ReturnType<typeof createTauriNativeUiApi>
  settings?: ReturnType<typeof createTauriNativeSettingsApi>
  browser?: ReturnType<typeof createTauriNativeBrowserApi>
  platform?: ReturnType<typeof createTauriNativePlatformNamespaceApi>['platform']
  app?: ReturnType<typeof createTauriNativeAppNamespaceApi>['app']
  repos?: ReturnType<typeof createTauriNativeRepositoriesApi>['repos']
  cli?: ReturnType<typeof createTauriNativeCliApi>
} {
  if (!isTauriNativeHost()) {
    return {}
  }
  const shell = createTauriNativeShellApi()
  const ui = createTauriNativeUiApi()
  const settings = createTauriNativeSettingsApi()
  const browser = createTauriNativeBrowserApi()
  return {
    ...(shell ? { shell } : {}),
    ...(ui ? { ui } : {}),
    ...(settings ? { settings } : {}),
    ...(browser ? { browser } : {}),
    ...createTauriNativePlatformNamespaceApi(),
    ...createTauriNativeAppNamespaceApi(),
    ...createTauriNativeRepositoriesApi(),
    cli: createTauriNativeCliApi()
  }
}

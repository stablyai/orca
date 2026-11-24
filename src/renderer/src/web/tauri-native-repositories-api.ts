import type { PreloadApi } from '../../../preload/api-types'
import { createReposApi } from './preload-api/workspaces/web-repositories-api'
import { invokePlugin, isTauriNativeHost } from './tauri-native-host'
import { translate } from '../i18n/i18n'

function pickedPaths(value: string | string[] | null): string[] {
  if (Array.isArray(value)) {
    return value
  }
  return value ? [value] : []
}

async function pickFolders(multiple: boolean): Promise<string[]> {
  const result = await invokePlugin<string | string[] | null>('dialog', 'open', {
    options: {
      title: translate('auto.web.tauriNative.dialog.selectProjectFolder', 'Select project folder'),
      directory: true,
      multiple
    }
  })
  return pickedPaths(result)
}

/** Native folder selection is required for the local desktop project flows. */
export function createTauriNativeRepositoriesApi(): Partial<PreloadApi> {
  if (!isTauriNativeHost()) {
    return {}
  }
  const repos = createReposApi()
  return {
    repos: {
      ...repos,
      pickFolder: async () => (await pickFolders(false))[0] ?? null,
      pickFolders: () => pickFolders(true),
      pickDirectory: async () => (await pickFolders(false))[0] ?? null
    }
  }
}

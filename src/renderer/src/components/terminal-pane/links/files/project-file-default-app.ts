import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import {
  isLivePlugin,
  usePluginPanelsStore
} from '@/store/plugins/catalog/plugin-contribution-catalog'
import { matchPluginFile } from '../../../../../../shared/plugins/contributions/plugin-file-match'

const creativeProjectFiles = { extensions: ['.blend', '.kra', '.psd', '.xcf'], filenames: [] }

export function prefersProjectFileDefaultApp(filePath: string): boolean {
  if (isPairedWebClientWindow() || !matchPluginFile(filePath, creativeProjectFiles)) {
    return false
  }
  const { plugins, fetchStatus } = usePluginPanelsStore.getState()
  return (
    fetchStatus === 'ready' &&
    !plugins.some(
      (plugin) =>
        isLivePlugin(plugin) &&
        plugin.customEditors?.some((editor) => matchPluginFile(filePath, editor))
    )
  )
}

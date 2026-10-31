import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { usePluginNewFiles } from '@/store/plugin-new-files'
import { withPluginNewFileMenuOptions, type TabCreateMenuOption } from './tab-create-menu-options'

/** The + menu's searchable options with enabled plugins' new files, and a select handler that
 *  creates those files itself and hands every other option on. */
export function usePluginNewFileMenuOptions(
  menuOptions: TabCreateMenuOption[],
  onSelectMenuOption: (option: TabCreateMenuOption) => void,
  groupId: string
): {
  menuOptions: TabCreateMenuOption[]
  onSelectMenuOption: (option: TabCreateMenuOption) => void
} {
  const newFiles = usePluginNewFiles()
  const options = useMemo(
    () =>
      newFiles.length === 0 ? menuOptions : withPluginNewFileMenuOptions(menuOptions, newFiles),
    [menuOptions, newFiles]
  )
  if (newFiles.length === 0) {
    return { menuOptions, onSelectMenuOption }
  }
  return {
    menuOptions: options,
    onSelectMenuOption: (option) => {
      if (option.kind !== 'new-plugin-file') {
        onSelectMenuOption(option)
        return
      }
      if (option.pluginNewFile) {
        void useAppStore
          .getState()
          .openNewPluginFileInActiveWorkspace(option.pluginNewFile, groupId)
      }
    }
  }
}

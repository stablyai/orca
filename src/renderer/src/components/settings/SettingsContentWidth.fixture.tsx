import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import type { NativeChatAppearanceSettings } from '../../../../shared/native-chat/native-chat-appearance-settings'
import Settings from './Settings'
import { ConfirmationDialogProvider } from '../confirmation-dialog'

function settingsWidth(
  pane: 'general' | 'appearance' | 'shortcuts' | 'plugins',
  width: NativeChatAppearanceSettings['width'],
  viewport = 1440
) {
  return defineFixture({
    width: viewport,
    store: {
      settings: {
        ...getDefaultSettings('/home/example'),
        uiLanguage: 'en',
        nativeChatAppearance: { width }
      },
      settingsNavigationTarget: { pane, repoId: null },
      fetchSettings: async () => {},
      fetchKeybindings: async () => {},
      refreshModelStates: async () => {}
    },
    render: () => (
      <div className="flex w-full" style={{ height: 900 }}>
        <ConfirmationDialogProvider>
          <Settings />
        </ConfirmationDialogProvider>
      </div>
    )
  })
}

export const generalComfortable = settingsWidth('general', 'comfortable')
export const generalWide = settingsWidth('general', 'wide')
export const generalFull = settingsWidth('general', 'full')
export const appearanceComfortable = settingsWidth('appearance', 'comfortable')
export const appearanceWide = settingsWidth('appearance', 'wide')
export const appearanceFull = settingsWidth('appearance', 'full')
export const shortcutsComfortable = settingsWidth('shortcuts', 'comfortable')
export const shortcutsWide = settingsWidth('shortcuts', 'wide')
export const shortcutsFull = settingsWidth('shortcuts', 'full')
export const pluginsComfortable = settingsWidth('plugins', 'comfortable')
export const pluginsWide = settingsWidth('plugins', 'wide')
export const pluginsFull = settingsWidth('plugins', 'full')
export const generalNarrow = settingsWidth('general', 'full', 800)

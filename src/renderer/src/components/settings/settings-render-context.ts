import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import type { SettingsTerminalModel } from './use-settings-terminal-model'
import type { SettingsNavigationActions, SettingsViewModel } from './settings-view-model'

export type LoadedSettingsStoreModel = Omit<SettingsStoreModel, 'settings'> & {
  settings: GlobalSettings
}

export type SettingsRenderContext = {
  model: LoadedSettingsStoreModel
  interactions: SettingsInteractionController
  navigation: SettingsNavigationModel
  terminal: SettingsTerminalModel
  actions: SettingsNavigationActions
  view: SettingsViewModel
}

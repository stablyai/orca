import type { Translate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsInteractionController } from './use-settings-interaction-controller'
import type { SettingsNavigationModel } from '../navigation/use-settings-navigation-model'
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

/** Name of the remote host Settings is scoped to, or null when scoped to this computer. */
export function getSettingsHostServerName(
  model: LoadedSettingsStoreModel,
  t: Translate
): string | null {
  const { target } = model.settingsHostScope
  return target.kind === 'environment'
    ? (model.runtimeEnvironments.find((entry) => entry.id === target.environmentId)?.name ??
        t('components.settings.notifications.server.fallbackHost', 'this server'))
    : null
}

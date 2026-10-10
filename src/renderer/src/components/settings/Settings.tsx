import { useSettingsStoreModel } from './use-settings-store-model'
import { useSettingsInteractionController } from './use-settings-interaction-controller'
import { useSettingsPageEffects } from './use-settings-page-effects'
import { useSettingsNavigationModel } from './use-settings-navigation-model'
import { useSettingsTerminalModel } from './use-settings-terminal-model'
import { useSettingsRepoScrollEffects } from './use-settings-repo-scroll-effects'
import { buildSettingsViewModel, useSettingsNavigationActions } from './settings-view-model'
import { renderSettingsLoading, renderSettingsPage } from './settings-page-renderer'
import type { LoadedSettingsStoreModel, SettingsRenderContext } from './settings-render-context'

function Settings(): React.JSX.Element {
  const model = useSettingsStoreModel()
  const interactions = useSettingsInteractionController(model)
  useSettingsPageEffects(model, interactions)
  const navigation = useSettingsNavigationModel(model, interactions)
  const terminal = useSettingsTerminalModel(model, navigation)
  useSettingsRepoScrollEffects(model, interactions, navigation, terminal)
  const actions = useSettingsNavigationActions(model, interactions)

  if (!model.settings) {
    return renderSettingsLoading(interactions)
  }

  const view = buildSettingsViewModel(model, navigation)
  const context: SettingsRenderContext = {
    model: model as LoadedSettingsStoreModel,
    interactions,
    navigation,
    terminal,
    actions,
    view
  }
  return renderSettingsPage(context)
}

export default Settings

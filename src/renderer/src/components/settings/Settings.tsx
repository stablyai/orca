import { useSettingsStoreModel } from './page/use-settings-store-model'
import { useSettingsInteractionController } from './page/use-settings-interaction-controller'
import { useSettingsPageEffects } from './page/use-settings-page-effects'
import { useSettingsNavigationModel } from './navigation/use-settings-navigation-model'
import { useSettingsTerminalModel } from './page/use-settings-terminal-model'
import { useSettingsRepoScrollEffects } from './navigation/use-settings-repo-scroll-effects'
import { buildSettingsViewModel, useSettingsNavigationActions } from './page/settings-view-model'
import { renderSettingsLoading, renderSettingsPage } from './page/settings-page-renderer'
import type {
  LoadedSettingsStoreModel,
  SettingsRenderContext
} from './page/settings-render-context'

function Settings(): React.JSX.Element {
  const storeModel = useSettingsStoreModel()
  const interactions = useSettingsInteractionController(storeModel)
  const navigation = useSettingsNavigationModel(storeModel, interactions)
  const model = navigation.model
  useSettingsPageEffects(model, interactions)
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

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
import { useTranslate } from '../../i18n/use-translate'

function Settings(): React.JSX.Element {
  const t = useTranslate()
  const model = useSettingsStoreModel()
  const interactions = useSettingsInteractionController(model)
  useSettingsPageEffects(model, interactions)
  const navigation = useSettingsNavigationModel(model, interactions)
  const terminal = useSettingsTerminalModel(model, navigation)
  useSettingsRepoScrollEffects(model, interactions, navigation, terminal)
  const actions = useSettingsNavigationActions(model, interactions)

  if (!model.settings) {
    return renderSettingsLoading(interactions, t)
  }

  const view = buildSettingsViewModel(model, navigation, t)
  const context: SettingsRenderContext = {
    model: model as LoadedSettingsStoreModel,
    interactions,
    navigation,
    terminal,
    actions,
    view
  }
  return renderSettingsPage(context, t)
}

export default Settings

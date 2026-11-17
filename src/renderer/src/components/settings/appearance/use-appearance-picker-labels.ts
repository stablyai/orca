import { getUiLanguageChoiceLabel, UI_LANGUAGE_CHOICES } from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { usePluginIconThemes } from '@/store/plugins/appearance/plugin-icon-themes'
import { usePluginLanguagePacks } from '@/store/plugins/localization/plugin-language-packs'
import { disambiguatedPluginContentLabels } from '../../plugins/presentation/plugin-name-disambiguation'

/** Icon themes with their picker labels; a plugin one sharing a name shows its publisher. */
export function useIconThemePickerLabels() {
  const t = useTranslate()
  const themes = usePluginIconThemes()
  const builtIn = t(
    'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.builtIn',
    'Built-in'
  )
  return { themes, builtIn, labels: disambiguatedPluginContentLabels(themes, [builtIn], t) }
}

/** Orca's languages, labelled as the language picker lists them, and installed language packs. */
export function useUiLanguagePickerLabels() {
  const packs = usePluginLanguagePacks()
  const choices = UI_LANGUAGE_CHOICES.map((choice) => getUiLanguageChoiceLabel(choice, translate))
  return { packs, choices }
}

import { getUiLanguageChoiceLabel, UI_LANGUAGE_CHOICES } from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'
import { usePluginIconThemes } from '@/store/plugin-icon-themes'
import { usePluginLanguagePacks } from '@/store/plugin-language-packs'
import { disambiguatedPluginContentLabels } from '../../plugins/presentation/plugin-name-disambiguation'

/** Icon themes with their picker labels; a plugin one sharing a name shows its publisher. */
export function useIconThemePickerLabels() {
  const themes = usePluginIconThemes()
  const builtIn = translate(
    'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.builtIn',
    'Built-in'
  )
  return { themes, builtIn, labels: disambiguatedPluginContentLabels(themes, [builtIn]) }
}

/** Orca's languages and plugin language packs, labelled as the language picker lists them. */
export function useUiLanguagePickerLabels() {
  const packs = usePluginLanguagePacks()
  const choices = UI_LANGUAGE_CHOICES.map((choice) => getUiLanguageChoiceLabel(choice, translate))
  const packLabels = disambiguatedPluginContentLabels(
    packs.map((pack) => ({
      ...pack,
      label: pack.displayName ?? `${pack.locale} — ${pack.pluginKey}`
    })),
    choices
  )
  return { packs, choices, packLabels }
}

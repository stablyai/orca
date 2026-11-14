import type React from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { normalizeUiLanguage, type UiLanguage } from '../../../../../shared/ui-language'
import { UI_LANGUAGE_CHOICES } from '@/i18n/supported-languages'
import { useLanguageReadiness } from '@/i18n/language-readiness'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsRow } from '../form-controls/SettingsFormControls'
import {
  SettingsSearchableSelect,
  type SettingsSearchableSelectOption
} from '../form-controls/SettingsSearchableSelect'
import { getLanguageEntries } from './appearance-search'
import { useUiLanguagePickerLabels } from './use-appearance-picker-labels'

type AppearanceLanguageSettingProps = {
  uiLanguage: UiLanguage
  updateSettings: (updates: Partial<GlobalSettings>) => void
  forceVisible: boolean
}

export function AppearanceLanguageSetting({
  uiLanguage,
  updateSettings,
  forceVisible
}: AppearanceLanguageSettingProps): React.JSX.Element {
  const t = useTranslate()
  const languages = useUiLanguagePickerLabels()
  const languageEntry = getLanguageEntries()[0]
  const languageTitle = t('settings.appearance.language.title', 'Language')
  const languageOptions: SettingsSearchableSelectOption[] = [
    ...UI_LANGUAGE_CHOICES.map((choice, index) => ({
      value: choice.value,
      label: languages.choices[index],
      keywords: [choice.value]
    })),
    ...languages.packs.map((pack) => ({
      value: pack.id,
      label: languages.packLabels.get(pack.id) ?? pack.locale,
      keywords: [pack.id, pack.locale]
    }))
  ]
  if (!languageOptions.some((option) => option.value === uiLanguage)) {
    languageOptions.push({
      value: uiLanguage,
      label: t(
        'auto.components.settings.AppearanceInterfaceSection.languageUnavailable',
        '{{value0}} (unavailable)',
        { value0: uiLanguage }
      ),
      disabled: true
    })
  }

  return (
    <SearchableSetting
      title={languageTitle}
      description={languageEntry?.description}
      keywords={languageEntry?.keywords ?? []}
      forceVisible={forceVisible}
    >
      <SettingsRow
        label={languageTitle}
        control={
          <SettingsSearchableSelect
            ariaLabel={languageTitle}
            value={uiLanguage}
            groups={[{ key: 'ui-languages', options: languageOptions }]}
            // Why: re-picking the saved language is the visible way to retry a catalog that failed to load.
            allowReselect
            onValueChange={(value) => {
              const next = normalizeUiLanguage(value)
              if (next !== uiLanguage) {
                updateSettings({ uiLanguage: next })
                return
              }
              const readiness = useLanguageReadiness.getState()
              if (readiness.error) {
                readiness.retryLanguageLoad()
              }
            }}
            searchPlaceholder={t(
              'auto.components.settings.SettingsSearchableSelect.searchLanguages',
              'Search languages…'
            )}
          />
        }
      />
    </SearchableSetting>
  )
}

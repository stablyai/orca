import type React from 'react'
import { useMemo } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { usePluginTerminalThemes, usePluginThemes } from '@/store/plugins/appearance/plugin-themes'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSegmentedControl } from '../settings/form-controls/SettingsFormControls'
import { buildThemeLooks, type ThemeLook, type ThemeLookBase } from './onboarding-theme-looks'
import { selectedThemeLookId } from './onboarding-theme-look-settings'

export type ThemeLooksByBase = Record<ThemeLookBase, ThemeLook[]>

/** The looks for both modes and which one each mode's slot holds now. */
export function useThemeLooks(
  settings: GlobalSettings | null,
  baseline: GlobalSettings | null
): {
  looks: ThemeLooksByBase
  selected: Record<ThemeLookBase, string | null>
  pluginTerminalThemes: ReturnType<typeof usePluginTerminalThemes>
} {
  const t = useTranslate()
  const pluginThemes = usePluginThemes()
  const pluginTerminalThemes = usePluginTerminalThemes()
  const languageRevision = useUiLanguageRevision()
  const looks = useMemo<ThemeLooksByBase>(() => {
    if (!baseline) {
      return { dark: [], light: [] }
    }
    const labels = {
      orca: t('components.onboarding.theme.looks.sourceBuiltIn', 'Built in'),
      community: t('components.onboarding.theme.looks.sourceCommunity', 'Terminal palette'),
      builtIn: (base: ThemeLookBase) =>
        base === 'dark'
          ? t('components.onboarding.theme.looks.orcaDark', 'Orca Dark')
          : t('components.onboarding.theme.looks.orcaLight', 'Orca Light')
    }
    const build = (base: ThemeLookBase): ThemeLook[] =>
      buildThemeLooks({ base, pluginThemes, pluginTerminalThemes, baseline, labels }, t)
    return { dark: build('dark'), light: build('light') }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- languageRevision re-reads translated labels
  }, [baseline, pluginThemes, pluginTerminalThemes, languageRevision, t])
  const selected = {
    dark: settings ? selectedThemeLookId(settings, 'dark', looks.dark) : null,
    light: settings ? selectedThemeLookId(settings, 'light', looks.light) : null
  }
  return { looks, selected, pluginTerminalThemes }
}

/** Under System: which of the two persisted looks the list edits; marks the one showing now. */
export function ThemeSlotControl({
  value,
  osBase,
  onChange
}: {
  value: ThemeLookBase
  osBase: ThemeLookBase
  onChange: (base: ThemeLookBase) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = (base: ThemeLookBase): React.ReactNode => (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      {base === 'dark'
        ? t('components.onboarding.theme.looks.darkLook', 'Dark look')
        : t('components.onboarding.theme.looks.lightLook', 'Light look')}
      {base === osBase && (
        <span className="text-2xs font-normal text-muted-foreground">
          {t('components.onboarding.theme.looks.activeNow', 'now')}
        </span>
      )}
    </span>
  )
  return (
    <SettingsSegmentedControl
      ariaLabel={t('components.onboarding.theme.looks.slotLabel', 'Look to edit')}
      value={value}
      onChange={onChange}
      equalWidth
      size="sm"
      options={[
        { value: 'dark', label: label('dark') },
        { value: 'light', label: label('light') }
      ]}
    />
  )
}

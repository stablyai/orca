import type React from 'react'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { SettingsSegmentedControl } from '../settings/form-controls/SettingsFormControls'

/** The step's primary choice: System, Dark, or Light. */
export function ThemeModeControl({
  value,
  onChange
}: {
  value: GlobalSettings['theme']
  onChange: (theme: GlobalSettings['theme']) => void
}): React.JSX.Element {
  const t = useTranslate()
  const themes: {
    id: GlobalSettings['theme']
    label: string
    hint: string
    icon: typeof Monitor
  }[] = [
    {
      id: 'system',
      label: t('auto.components.onboarding.ThemeStep.827ea7b4a2', 'System'),
      hint: t('components.onboarding.theme.hints.system', 'Match OS'),
      icon: Monitor
    },
    {
      id: 'dark',
      label: t('auto.components.onboarding.ThemeStep.fa7b673ea9', 'Dark'),
      hint: t('components.onboarding.theme.hints.dark', 'Easy on the eyes'),
      icon: Moon
    },
    {
      id: 'light',
      label: t('auto.components.onboarding.ThemeStep.ad192706e6', 'Light'),
      hint: t('components.onboarding.theme.hints.light', 'Bright & crisp'),
      icon: Sun
    }
  ]
  const activeTheme = themes.find(({ id }) => id === value) ?? themes[0]

  return (
    <div className="flex items-center gap-3">
      <SettingsSegmentedControl
        ariaLabel={t('components.onboarding.theme.looks.colorMode', 'Color mode')}
        value={value}
        onChange={onChange}
        size="icon"
        overlayTooltip
        options={themes.map(({ id, label, hint, icon: Icon }) => {
          const description = `${label} · ${hint}`
          return {
            value: id,
            label: <Icon className="size-3.5" />,
            ariaLabel: description,
            tooltip: description
          }
        })}
      />
      <span className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{activeTheme.label}</span>
        {' · '}
        {activeTheme.hint}
      </span>
    </div>
  )
}

import type React from 'react'
import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { ChromePreview } from './theme-chrome-preview'

/** The step's primary choice: System, Dark, or Light. */
export function ThemeModeTiles({
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

  return (
    <div className="grid grid-cols-3 gap-3">
      {themes.map(({ id, label, hint, icon: Icon }) => {
        const selected = value === id
        return (
          <button
            key={id}
            className={cn(
              'group overflow-hidden rounded-xl border p-3 text-left transition-colors',
              selected ? 'border-foreground/60 bg-accent' : 'border-border hover:bg-accent/60'
            )}
            aria-pressed={selected}
            onClick={() => onChange(id)}
          >
            <div className="relative mb-3 h-24 overflow-hidden rounded-lg border border-border">
              <ChromePreview variant={id} />
              {selected && (
                <div className="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background shadow-sm">
                  <Check className="size-3" strokeWidth={3} />
                </div>
              )}
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                <Icon className="size-3.5 text-muted-foreground" />
                {label}
              </div>
              <div className="text-[11px] text-muted-foreground">{hint}</div>
            </div>
          </button>
        )
      })}
    </div>
  )
}

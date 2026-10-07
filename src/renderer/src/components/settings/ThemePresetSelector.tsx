import type React from 'react'
import { Check } from 'lucide-react'
import type { AppThemePresetId } from '../../../../shared/global-settings-types'
import { APP_THEME_PRESETS, resolveEffectiveThemePreset } from '@/lib/app-theme-presets'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type ThemePresetSelectorProps = {
  value: AppThemePresetId | undefined
  onChange: (presetId: AppThemePresetId) => void
  effectiveMode: 'dark' | 'light'
}

/**
 * Grid selector allowing users to choose an interface color preset with visual palette swatches.
 */
export function ThemePresetSelector({
  value = 'default',
  onChange,
  effectiveMode
}: ThemePresetSelectorProps): React.JSX.Element {
  const visiblePresets = APP_THEME_PRESETS.filter(
    (preset) => preset.id === 'default' || preset.mode === effectiveMode
  )

  const effectiveSelectedPresetId = resolveEffectiveThemePreset(
    effectiveMode,
    value,
    effectiveMode === 'dark'
  )

  return (
    <div
      role="radiogroup"
      aria-label={translate('settings.appearance.themePresets.groupLabel', 'Theme Presets')}
      className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3"
    >
      {visiblePresets.map((preset) => {
        const isSelected = effectiveSelectedPresetId === preset.id

        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={isSelected}
            onClick={() => onChange(preset.id)}
            className={cn(
              'group relative flex flex-col justify-between rounded-xl border p-3 text-left transition-colors',
              'hover:bg-accent/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              isSelected ? 'border-ring/80 bg-accent/25 shadow-xs' : 'border-border/60 bg-card/60'
            )}
          >
            <div className="flex w-full items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-foreground">
                  {preset.name}
                </span>
                {preset.description ? (
                  <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                    {translate(
                      `settings.appearance.themePresets.${preset.id}.description`,
                      preset.description
                    )}
                  </span>
                ) : null}
              </div>
              <div
                className={cn(
                  'grid size-4 shrink-0 place-items-center rounded-full border transition-colors',
                  isSelected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-muted-foreground/30 opacity-0 group-hover:opacity-100'
                )}
                aria-hidden="true"
              >
                {isSelected ? <Check className="size-2.5 stroke-[3]" /> : null}
              </div>
            </div>

            <div className="mt-3 flex items-center gap-1.5" aria-hidden="true">
              <span
                className="size-4 shrink-0 rounded-full border border-black/10 dark:border-white/10"
                style={{ backgroundColor: preset.swatches.background }}
                title={translate(
                  'settings.appearance.themePresets.swatch.background',
                  'Background'
                )}
              />
              <span
                className="size-4 shrink-0 rounded-full border border-black/10 dark:border-white/10"
                style={{ backgroundColor: preset.swatches.card }}
                title={translate('settings.appearance.themePresets.swatch.card', 'Card')}
              />
              <span
                className="size-4 shrink-0 rounded-full border border-black/10 dark:border-white/10"
                style={{ backgroundColor: preset.swatches.primary }}
                title={translate('settings.appearance.themePresets.swatch.primary', 'Primary')}
              />
              <span
                className="size-4 shrink-0 rounded-full border border-black/10 dark:border-white/10"
                style={{ backgroundColor: preset.swatches.accent }}
                title={translate('settings.appearance.themePresets.swatch.accent', 'Accent')}
              />
            </div>
          </button>
        )
      })}
    </div>
  )
}

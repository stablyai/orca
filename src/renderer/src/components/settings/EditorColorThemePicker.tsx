import type React from 'react'
import { ScrollArea } from '../ui/scroll-area'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { MAX_THEME_RESULTS } from './SettingsConstants'
import {
  filterEditorColorThemeOptions,
  isSettingsFormOptionQueryTooLarge
} from './settings-form-option-filter'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { EditorColorThemeOption, EditorColorThemeValue } from '@/lib/editor-theme'

type EditorColorThemePickerProps = {
  label: string
  description: string
  selectedTheme: EditorColorThemeValue
  themeOptions: EditorColorThemeOption[]
  query: string
  onQueryChange: (value: string) => void
  onSelectTheme: (theme: EditorColorThemeValue) => void
}

/** Editor color theme picker: search + swatch-preview rows, grouped by
 *  Follow App Theme / Built-in / Catalog — the editor-theme mirror of
 *  TerminalThemePicker.tsx's ThemePicker. */
export function EditorColorThemePicker({
  label,
  description,
  selectedTheme,
  themeOptions,
  query,
  onQueryChange,
  onSelectTheme
}: EditorColorThemePickerProps): React.JSX.Element {
  const themeQuery = query.trim()
  const shouldShowThemeQueryLabel =
    themeQuery.length > 0 && !isSettingsFormOptionQueryTooLarge(themeQuery)
  const matchingThemes = filterEditorColorThemeOptions(themeOptions, query)
  const selectedThemeLabel =
    themeOptions.find((option) => option.value === selectedTheme)?.label ?? selectedTheme
  const groupedThemes = [
    {
      label: translate('auto.components.settings.EditorColorThemePicker.group_auto', 'App Theme'),
      themes: matchingThemes.filter((theme) => theme.group === 'auto')
    },
    {
      label: translate('auto.components.settings.EditorColorThemePicker.group_builtin', 'Built-in'),
      themes: matchingThemes
        .filter((theme) => theme.group === 'builtin')
        .slice(0, MAX_THEME_RESULTS)
    },
    {
      label: translate('auto.components.settings.EditorColorThemePicker.group_catalog', 'Themes'),
      themes: matchingThemes
        .filter((theme) => theme.group === 'catalog')
        .slice(0, MAX_THEME_RESULTS)
    }
  ].filter((group) => group.themes.length > 0)
  const visibleThemeCount = groupedThemes.reduce((sum, group) => sum + group.themes.length, 0)

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder={translate(
          'auto.components.settings.EditorColorThemePicker.search_placeholder',
          'Search editor themes'
        )}
      />
      <div className="rounded-lg border border-border/50">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {translate('auto.components.settings.EditorColorThemePicker.selected', 'Selected:')}{' '}
            {selectedThemeLabel}
          </span>
          <span>
            {translate('auto.components.settings.EditorColorThemePicker.showing', 'Showing')}{' '}
            {visibleThemeCount}
            {shouldShowThemeQueryLabel
              ? translate(
                  'auto.components.settings.EditorColorThemePicker.matching',
                  ' matching "{{value0}}"',
                  { value0: themeQuery }
                )
              : translate(
                  'auto.components.settings.EditorColorThemePicker.ofTotal',
                  ' of {{value0}}',
                  { value0: themeOptions.length }
                )}
          </span>
        </div>
        <ScrollArea className="h-64">
          <div className="space-y-1 p-2">
            {groupedThemes.map((group) => (
              <div key={group.label} className="space-y-1">
                <p className="px-3 pt-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
                  {group.label}
                </p>
                {group.themes.map((theme) => (
                  <button
                    key={theme.value}
                    onClick={() => onSelectTheme(theme.value)}
                    className={cn(
                      'flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors',
                      selectedTheme === theme.value
                        ? 'bg-accent font-medium text-accent-foreground'
                        : 'hover:bg-accent'
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{theme.label}</span>
                    {theme.swatch && selectedTheme !== theme.value ? (
                      <span className="flex shrink-0 overflow-hidden rounded-sm border border-border/60">
                        {theme.swatch.map((color, index) => (
                          <span
                            key={index}
                            className="h-3 w-2"
                            style={{ backgroundColor: color }}
                          />
                        ))}
                      </span>
                    ) : null}
                    {selectedTheme === theme.value ? (
                      <span className="ml-3 shrink-0 text-[11px] uppercase tracking-[0.16em]">
                        {translate(
                          'auto.components.settings.EditorColorThemePicker.current',
                          'Current'
                        )}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            ))}
            {visibleThemeCount === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.EditorColorThemePicker.no_results',
                  'No themes found.'
                )}
              </div>
            ) : null}
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}

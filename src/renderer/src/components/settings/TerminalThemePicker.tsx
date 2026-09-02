import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { ScrollArea } from '../ui/scroll-area'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { MAX_THEME_RESULTS } from './SettingsConstants'
import {
  filterTerminalThemeOptions,
  isSettingsFormOptionQueryTooLarge
} from './settings-form-option-filter'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { TerminalThemeOption } from '@/lib/terminal-theme'

type ThemePickerProps = {
  label: string
  description: string
  selectedTheme: string
  themeOptions: TerminalThemeOption[]
  query: string
  onQueryChange: (value: string) => void
  onSelectTheme: (theme: string) => void
  /** Bumps when themes are imported; scrolls the Imported group into view and
   *  briefly highlights it so freshly-imported themes are easy to find. */
  importedHighlightSignal?: number
}

export function ThemePicker({
  label,
  description,
  selectedTheme,
  themeOptions,
  query,
  onQueryChange,
  onSelectTheme,
  importedHighlightSignal
}: ThemePickerProps): React.JSX.Element {
  const importedGroupRef = useRef<HTMLDivElement | null>(null)
  const [highlightImported, setHighlightImported] = useState(false)

  // Why: imported themes render below the built-in list inside a fixed-height
  // scroll area, so after an import they sit off-screen. On each import signal,
  // scroll the Imported group into view and flash a highlight so it's easy to spot.
  useEffect(() => {
    if (!importedHighlightSignal) {
      return
    }
    importedGroupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    setHighlightImported(true)
    const timer = setTimeout(() => setHighlightImported(false), 2000)
    return () => clearTimeout(timer)
  }, [importedHighlightSignal])

  const themeQuery = query.trim()
  const shouldShowThemeQueryLabel =
    themeQuery.length > 0 && !isSettingsFormOptionQueryTooLarge(themeQuery)
  const matchingThemes = filterTerminalThemeOptions(themeOptions, query)
  const selectedThemeLabel =
    themeOptions.find((option) => option.value === selectedTheme)?.label ?? selectedTheme
  const groupedThemes = [
    {
      label: translate('auto.components.settings.SettingsFormControls.builtin_themes', 'Built-in'),
      themes: matchingThemes
        .filter((theme) => theme.group === 'built-in')
        .slice(0, MAX_THEME_RESULTS)
    },
    {
      label: translate('auto.components.settings.SettingsFormControls.imported_themes', 'Imported'),
      themes: matchingThemes
        .filter((theme) => theme.group === 'imported')
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
          'auto.components.settings.SettingsFormControls.search_terminal_themes',
          'Search terminal themes'
        )}
      />
      <div className="rounded-lg border border-border/50">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
          <span>
            {translate('auto.components.settings.SettingsFormControls.fbb428db98', 'Selected:')}{' '}
            {selectedThemeLabel}
          </span>
          <span>
            {translate('auto.components.settings.SettingsFormControls.4e11f87ca6', 'Showing')}{' '}
            {visibleThemeCount}
            {shouldShowThemeQueryLabel
              ? translate(
                  'auto.components.settings.SettingsFormControls.c822571b2e',
                  ' matching "{{value0}}"',
                  { value0: themeQuery }
                )
              : translate(
                  'auto.components.settings.SettingsFormControls.cb330ef7f8',
                  ' of {{value0}}',
                  { value0: themeOptions.length }
                )}
          </span>
        </div>
        <ScrollArea className="h-64">
          <div className="space-y-1 p-2">
            {groupedThemes.map((group) => {
              const isImported =
                group.label ===
                translate(
                  'auto.components.settings.SettingsFormControls.imported_themes',
                  'Imported'
                )
              return (
                <div
                  key={group.label}
                  ref={isImported ? importedGroupRef : undefined}
                  className={cn(
                    'space-y-1 rounded-md transition-colors duration-500',
                    isImported && highlightImported && 'bg-accent/40 ring-1 ring-accent'
                  )}
                >
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
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{theme.label}</span>
                        {theme.sourceLabel ? (
                          <span className="block truncate text-[11px] font-normal text-muted-foreground">
                            {translate(
                              'auto.components.settings.SettingsFormControls.imported_from',
                              'Imported from {{value0}}',
                              { value0: theme.sourceLabel }
                            )}
                            {theme.mode && theme.mode !== 'unknown' ? ` · ${theme.mode}` : ''}
                          </span>
                        ) : null}
                      </span>
                      {/* Why: hide swatches on the current row so the color grid
                        doesn't shift left to make room for the "Current" label. */}
                      {theme.group === 'imported' &&
                      theme.previewTheme &&
                      selectedTheme !== theme.value ? (
                        <span className="flex shrink-0 overflow-hidden rounded-sm border border-border/60">
                          {[
                            theme.previewTheme.black,
                            theme.previewTheme.red,
                            theme.previewTheme.green,
                            theme.previewTheme.yellow,
                            theme.previewTheme.blue,
                            theme.previewTheme.magenta,
                            theme.previewTheme.cyan,
                            theme.previewTheme.white
                          ].map((color, index) => (
                            <span
                              key={index}
                              className="h-3 w-2"
                              style={{ backgroundColor: color ?? 'transparent' }}
                            />
                          ))}
                        </span>
                      ) : null}
                      {selectedTheme === theme.value ? (
                        <span className="ml-3 shrink-0 text-[11px] uppercase tracking-[0.16em]">
                          {translate(
                            'auto.components.settings.SettingsFormControls.9119fb2268',
                            'Current'
                          )}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )
            })}
            {visibleThemeCount === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">
                {translate(
                  'auto.components.settings.SettingsFormControls.ceefb9d7f1',
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

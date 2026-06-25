/* eslint-disable max-lines -- Why: these small settings form primitives and controls
co-locate shared layout and keyboard interaction logic, which keeps the settings
panel wiring simple even though the file exceeds the default line limit. */
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ScrollArea } from '../ui/scroll-area'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Check, ChevronsUpDown, CircleX } from 'lucide-react'
import { normalizeColor, type TerminalThemeOption } from '@/lib/terminal-theme'
import { MAX_THEME_RESULTS } from './SettingsConstants'
import {
  filterFontSuggestions,
  filterTerminalThemeOptions,
  isSettingsFormOptionQueryTooLarge
} from './settings-form-option-filter'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type SettingsSwitchProps = {
  checked: boolean
  onChange: () => void
  ariaLabel?: string
  ariaLabelledBy?: string
  disabled?: boolean
}

export function SettingsSwitch({
  checked,
  onChange,
  ariaLabel,
  ariaLabelledBy,
  disabled
}: SettingsSwitchProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-foreground' : 'bg-muted-foreground/30'
      )}
    >
      <span
        className={cn(
          'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0.5'
        )}
      />
    </button>
  )
}

type SettingsRowProps = {
  label: React.ReactNode
  description?: React.ReactNode
  control: React.ReactNode
  /** Optional id applied to the label so the control can reference it via aria-labelledby. */
  labelId?: string
  /** When true, top-align label/description and control. Useful for tall control columns. */
  alignTop?: boolean
}

/** Two-column row grammar: left min-w-0 label+description, right shrink-0 control. */
export function SettingsRow({
  label,
  description,
  control,
  labelId,
  alignTop
}: SettingsRowProps): React.JSX.Element {
  return (
    <div
      className={cn('flex gap-4 py-2', alignTop ? 'items-start' : 'items-center justify-between')}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label id={labelId}>{label}</Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}

type SettingsSwitchRowProps = {
  label: React.ReactNode
  description?: React.ReactNode
  checked: boolean
  onChange: () => void
  ariaLabel?: string
}

export function SettingsSwitchRow({
  label,
  description,
  checked,
  onChange,
  ariaLabel
}: SettingsSwitchRowProps): React.JSX.Element {
  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <SettingsSwitch
          checked={checked}
          onChange={onChange}
          ariaLabel={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        />
      }
    />
  )
}

type SegmentedOption<T extends string | number> = {
  value: T
  label: React.ReactNode
  disabled?: boolean
  ariaLabel?: string
}

type SettingsSegmentedControlProps<T extends string | number> = {
  value: T
  onChange: (value: T) => void
  options: readonly SegmentedOption<T>[]
  ariaLabel?: string
  size?: 'sm' | 'md'
  equalWidth?: boolean
}

/** Canonical segmented control for theme/ligatures/cursor/shell/etc. */
export function SettingsSegmentedControl<T extends string | number>({
  value,
  onChange,
  options,
  ariaLabel,
  size = 'md',
  equalWidth = false
}: SettingsSegmentedControlProps<T>): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center rounded-md border border-border bg-background/50 p-0.5',
        equalWidth && 'w-full'
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={opt.ariaLabel}
            disabled={opt.disabled}
            onClick={() => {
              if (!opt.disabled) {
                onChange(opt.value)
              }
            }}
            className={cn(
              'rounded-sm text-center outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm',
              equalWidth && 'flex-1',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : opt.disabled
                  ? 'cursor-not-allowed text-muted-foreground/50'
                  : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

type SettingsBadgeProps = {
  tone?: 'neutral' | 'accent' | 'muted'
  children: React.ReactNode
  className?: string
}

/** Tokenized badge for status pills inside settings (e.g. Detected, Not installed). */
export function SettingsBadge({
  tone = 'neutral',
  children,
  className
}: SettingsBadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
        tone === 'accent'
          ? 'border-foreground/20 bg-foreground/10 text-foreground'
          : tone === 'muted'
            ? 'border-border/40 bg-muted/30 text-muted-foreground'
            : 'border-border/50 bg-background/50 text-foreground/80',
        className
      )}
    >
      {children}
    </span>
  )
}

type SettingsSubsectionHeaderProps = {
  title: React.ReactNode
  description?: React.ReactNode
  action?: React.ReactNode
}

/** Consistent subsection header: h3 text-sm font-semibold + optional muted description. */
export function SettingsSubsectionHeader({
  title,
  description,
  action
}: SettingsSubsectionHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

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

type ColorFieldProps = {
  label: string
  description: string
  value: string
  fallback: string
  onChange: (value: string) => void
}

type NumberFieldProps = {
  label: string
  description: string
  value: number
  defaultValue?: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  suffix?: string
}

type FontAutocompleteProps = {
  value: string
  suggestions: string[]
  onChange: (value: string) => void
  placeholder?: string
  /** Fires with whichever option the user is currently highlighting in the
   *  dropdown (via mouse hover or keyboard arrow), or null when nothing is
   *  highlighted / the dropdown is closed. Lets a consumer show a live
   *  preview of the font without committing the selection. */
  onPreviewFontFamily?: (font: string | null) => void
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

export function ColorField({
  label,
  description,
  value,
  fallback,
  onChange
}: ColorFieldProps): React.JSX.Element {
  const normalized = normalizeColor(value, fallback)

  return (
    <SettingsRow
      label={label}
      description={description}
      control={
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={normalized}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-10 rounded-md border border-input bg-transparent p-1"
          />
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={fallback}
            className="w-32 text-xs"
          />
        </div>
      }
    />
  )
}

export function NumberField({
  label,
  description,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  onChange,
  suffix
}: NumberFieldProps): React.JSX.Element {
  const [draft, setDraft] = useState(Number.isFinite(value) ? String(value) : '')
  const [prevValue, setPrevValue] = useState(value)

  // Sync draft when the external value changes (e.g. from another source)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(Number.isFinite(value) ? String(value) : '')
  }

  const commit = (): void => {
    const trimmed = draft.trim()
    if (trimmed === '') {
      // Empty input — reset to current value rather than committing 0
      setDraft(Number.isFinite(value) ? String(value) : '')
      return
    }
    const next = Number(trimmed)
    if (Number.isFinite(next)) {
      const clamped = Math.min(max, Math.max(min, next))
      onChange(clamped)
      setDraft(String(clamped))
    } else {
      // Reset to current value if input is invalid
      setDraft(Number.isFinite(value) ? String(value) : '')
    }
  }

  return (
    <SettingsRow
      label={label}
      description={
        <>
          {description}
          {defaultValue !== undefined ? (
            <span className="ml-1 text-muted-foreground/70">
              {translate('auto.components.settings.SettingsFormControls.b661b034ec', '· Default:')}{' '}
              {defaultValue}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={min}
            max={max}
            step={step}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                commit()
              }
            }}
            className="number-input-clean w-24 tabular-nums"
          />
          {suffix ? <span className="shrink-0 text-xs text-muted-foreground">{suffix}</span> : null}
        </div>
      }
    />
  )
}

export function FontAutocomplete({
  value,
  suggestions,
  onChange,
  placeholder = 'SF Mono',
  onPreviewFontFamily
}: FontAutocompleteProps): React.JSX.Element {
  const [query, setQuery] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [isFilteringQuery, setIsFilteringQuery] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const previewFontFamilyRef = useRef(onPreviewFontFamily)
  const listboxId = useId()

  previewFontFamilyRef.current = onPreviewFontFamily

  const setRootNode = useCallback((element: HTMLDivElement | null): void => {
    rootRef.current = element
    if (!element) {
      // Why: settings search can unmount this control while a hover preview is
      // active; the consumer must not keep rendering that transient font.
      previewFontFamilyRef.current?.(null)
    }
  }, [])

  if (value !== prevValue) {
    setPrevValue(value)
    setQuery(value)
    if (value !== query) {
      setIsFilteringQuery(false)
    }
  }

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
        setIsFilteringQuery(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const normalizedQuery = query.trim().toLowerCase()
  const normalizedValue = value.trim().toLowerCase()
  const filteredSuggestions = useMemo(
    () => filterFontSuggestions(suggestions, query),
    [suggestions, query]
  )
  // Why: the committed font fills the input, but opening the chooser should
  // still reveal every installed font instead of only fonts sharing that name.
  const visibleSuggestions =
    !isFilteringQuery && normalizedQuery === normalizedValue ? suggestions : filteredSuggestions

  // Why: sync the highlighted index during render rather than via useEffect so
  // the correct item is highlighted on the very first paint after open/filter
  // changes — useEffect would leave one render with the stale index visible.
  const [prevVisibleSuggestions, setPrevVisibleSuggestions] = useState(visibleSuggestions)
  const [prevOpen, setPrevOpen] = useState(open)
  const [prevHighlightedValue, setPrevHighlightedValue] = useState(value)
  if (
    visibleSuggestions !== prevVisibleSuggestions ||
    open !== prevOpen ||
    value !== prevHighlightedValue
  ) {
    setPrevVisibleSuggestions(visibleSuggestions)
    setPrevOpen(open)
    setPrevHighlightedValue(value)
    if (!open || visibleSuggestions.length === 0) {
      setHighlightedIndex(-1)
    } else {
      const selectedIndex = visibleSuggestions.findIndex((font) => font === value)
      setHighlightedIndex(Math.max(selectedIndex, 0))
    }
  }

  // Why: notify the consumer of the currently-highlighted font so it can
  // render a live preview. Closing the dropdown or moving past all options
  // clears the preview back to the committed value.
  useEffect(() => {
    if (!onPreviewFontFamily) {
      return
    }
    if (!open || highlightedIndex < 0) {
      onPreviewFontFamily(null)
      return
    }
    onPreviewFontFamily(visibleSuggestions[highlightedIndex] ?? null)
  }, [visibleSuggestions, highlightedIndex, onPreviewFontFamily, open])

  const commitValue = (nextValue: string): void => {
    setQuery(nextValue)
    setIsFilteringQuery(false)
    onChange(nextValue)
    setOpen(false)
  }

  const focusInput = (): void => {
    inputRef.current?.focus()
  }

  return (
    <div ref={setRootNode} className="relative max-w-sm">
      <div className="relative">
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            const next = e.target.value
            setQuery(next)
            setIsFilteringQuery(true)
            onChange(next)
            setOpen(true)
          }}
          onFocus={() => {
            setIsFilteringQuery(false)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (open) {
                e.preventDefault()
                setOpen(false)
                setIsFilteringQuery(false)
              }
              return
            }

            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              if (visibleSuggestions.length > 0) {
                setHighlightedIndex((current) =>
                  current < 0 ? 0 : Math.min(current + 1, visibleSuggestions.length - 1)
                )
              }
              return
            }

            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
              if (visibleSuggestions.length > 0) {
                setHighlightedIndex((current) =>
                  current < 0 ? visibleSuggestions.length - 1 : Math.max(current - 1, 0)
                )
              }
              return
            }

            if (e.key === 'Enter' && open && highlightedIndex >= 0) {
              const highlightedFont = visibleSuggestions[highlightedIndex]
              if (highlightedFont) {
                e.preventDefault()
                commitValue(highlightedFont)
              }
            }
          }}
          placeholder={placeholder}
          className="pr-18"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            open && highlightedIndex >= 0 ? `${listboxId}-option-${highlightedIndex}` : undefined
          }
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {query ? (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery('')
                setIsFilteringQuery(false)
                onChange('')
                setOpen(true)
                focusInput()
              }}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label={translate(
                'auto.components.settings.SettingsFormControls.a4ff6143f8',
                'Clear font selection'
              )}
              title={translate('auto.components.settings.SettingsFormControls.74bcecd5ec', 'Clear')}
            >
              <CircleX className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const nextOpen = !open
              setOpen(nextOpen)
              if (!nextOpen) {
                setIsFilteringQuery(false)
              }
              if (nextOpen) {
                focusInput()
              }
            }}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={translate(
              'auto.components.settings.SettingsFormControls.c766f8ac75',
              'Toggle font suggestions'
            )}
            title={translate('auto.components.settings.SettingsFormControls.b55371ea18', 'Fonts')}
          >
            <ChevronsUpDown className="size-3.5" />
          </button>
        </div>
      </div>

      {open ? (
        <div className="absolute top-full z-20 mt-2 w-full overflow-hidden rounded-md border border-border/50 bg-popover shadow-md">
          <ScrollArea className={visibleSuggestions.length > 8 ? 'h-64' : undefined}>
            <div id={listboxId} role="listbox" className="p-1">
              {visibleSuggestions.length > 0 ? (
                visibleSuggestions.map((font, index) => (
                  <button
                    key={font}
                    type="button"
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === highlightedIndex}
                    ref={(element) => {
                      if (element && index === highlightedIndex) {
                        element.scrollIntoView({ block: 'nearest' })
                      }
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(index)}
                    onClick={() => commitValue(font)}
                    className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors ${
                      index === highlightedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/60'
                    }`}
                  >
                    <span className="truncate">{font}</span>
                    {font === value ? <Check className="ml-3 size-4 shrink-0" /> : null}
                  </button>
                ))
              ) : (
                <div className="px-3 py-3 text-sm text-muted-foreground">
                  {translate(
                    'auto.components.settings.SettingsFormControls.42a4d15a30',
                    'No matching fonts.'
                  )}
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}

import { useEffect, useState, useMemo, useRef } from 'react'
import { ScrollArea } from '../ui/scroll-area'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Check, ChevronsUpDown, CircleX } from 'lucide-react'
import { BUILTIN_TERMINAL_THEME_NAMES, normalizeColor } from '@/lib/terminal-theme'
import { MAX_THEME_RESULTS, MAX_FONT_RESULTS } from './SettingsConstants'

type ThemePickerProps = {
  label: string
  description: string
  selectedTheme: string
  query: string
  onQueryChange: (value: string) => void
  onSelectTheme: (theme: string) => void
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
}

export function ThemePicker({
  label,
  description,
  selectedTheme,
  query,
  onQueryChange,
  onSelectTheme
}: ThemePickerProps): React.JSX.Element {
  const normalizedQuery = query.trim().toLowerCase()
  const filteredThemes = BUILTIN_TERMINAL_THEME_NAMES.filter((theme) =>
    theme.toLowerCase().includes(normalizedQuery)
  ).slice(0, MAX_THEME_RESULTS)

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search builtin themes"
      />
      <div className="rounded-lg border">
        <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
          <span>Selected: {selectedTheme}</span>
          <span>
            Showing {filteredThemes.length}
            {normalizedQuery
              ? ` matching "${query.trim()}"`
              : ` of ${BUILTIN_TERMINAL_THEME_NAMES.length}`}
          </span>
        </div>
        <ScrollArea className="h-64">
          <div className="space-y-1 p-2">
            {filteredThemes.map((theme) => (
              <button
                key={theme}
                onClick={() => onSelectTheme(theme)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors ${
                  selectedTheme === theme
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'hover:bg-muted/60'
                }`}
              >
                <span className="truncate">{theme}</span>
                {selectedTheme === theme ? (
                  <span className="ml-3 shrink-0 text-[11px] uppercase tracking-[0.16em]">
                    Current
                  </span>
                ) : null}
              </button>
            ))}
            {filteredThemes.length === 0 ? (
              <div className="px-3 py-6 text-sm text-muted-foreground">No themes found.</div>
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
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={normalized}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-12 rounded-md border border-input bg-transparent p-1"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={fallback}
          className="max-w-xs font-mono text-xs"
        />
      </div>
    </div>
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
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <Label className="text-sm">{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? String(value) : ''}
          onChange={(e) => {
            const next = Number(e.target.value)
            if (!Number.isFinite(next)) {
              return
            }
            onChange(next)
          }}
          className="number-input-clean w-28 tabular-nums"
        />
        {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Current: {value}
        {defaultValue !== undefined ? ` · Default: ${defaultValue}` : ''}
      </p>
    </div>
  )
}

export function FontAutocomplete({
  value,
  suggestions,
  onChange
}: FontAutocompleteProps): React.JSX.Element {
  const [query, setQuery] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  if (value !== prevValue) {
    setPrevValue(value)
    setQuery(value)
  }

  useEffect(() => {
    if (!open) {
      return
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open])

  const normalizedQuery = query.trim().toLowerCase()
  const filteredSuggestions = useMemo(() => {
    const startsWith = suggestions.filter((font) => font.toLowerCase().startsWith(normalizedQuery))
    const includes = suggestions.filter(
      (font) =>
        !font.toLowerCase().startsWith(normalizedQuery) &&
        font.toLowerCase().includes(normalizedQuery)
    )
    const ordered = normalizedQuery ? [...startsWith, ...includes] : suggestions
    return ordered.slice(0, MAX_FONT_RESULTS)
  }, [suggestions, normalizedQuery])

  const commitValue = (nextValue: string): void => {
    setQuery(nextValue)
    onChange(nextValue)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className="relative max-w-sm">
      <div className="relative">
        <Input
          value={query}
          onChange={(e) => {
            const next = e.target.value
            setQuery(next)
            onChange(next)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          placeholder="SF Mono"
          className="pr-18"
        />
        <div className="absolute inset-y-0 right-2 flex items-center gap-1">
          {query ? (
            <button
              type="button"
              onClick={() => {
                setQuery('')
                onChange('')
                setOpen(true)
              }}
              className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Clear font selection"
              title="Clear"
            >
              <CircleX className="size-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Toggle font suggestions"
            title="Fonts"
          >
            <ChevronsUpDown className="size-3.5" />
          </button>
        </div>
      </div>

      {open ? (
        <div className="absolute top-full z-20 mt-2 w-full overflow-hidden rounded-md border bg-popover shadow-md">
          <ScrollArea className="max-h-64">
            <div className="p-1">
              {filteredSuggestions.length > 0 ? (
                filteredSuggestions.map((font) => (
                  <button
                    key={font}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commitValue(font)}
                    className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors ${
                      font === value ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/60'
                    }`}
                  >
                    <span className="truncate">{font}</span>
                    {font === value ? <Check className="ml-3 size-4 shrink-0" /> : null}
                  </button>
                ))
              ) : (
                <div className="px-3 py-3 text-sm text-muted-foreground">No matching fonts.</div>
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}

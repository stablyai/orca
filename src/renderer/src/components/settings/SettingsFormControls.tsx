import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { ScrollArea } from '../ui/scroll-area'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Check, ChevronsUpDown, CircleX } from 'lucide-react'
import { BUILTIN_TERMINAL_THEME_NAMES, normalizeColor } from '@/lib/terminal-theme'
import { MAX_THEME_RESULTS } from './SettingsConstants'

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
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search builtin themes"
      />
      <div className="rounded-lg border border-border/50">
        <div className="flex items-center justify-between border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
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
        <Label>{label}</Label>
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
          className="max-w-xs text-xs"
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
    <div className="space-y-2">
      <div className="space-y-1">
        <Label>{label}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-3">
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
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef(new Map<string, HTMLButtonElement>())
  const listboxId = useId()

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
    return normalizedQuery ? [...startsWith, ...includes] : suggestions
  }, [suggestions, normalizedQuery])

  useEffect(() => {
    if (!open || filteredSuggestions.length === 0) {
      setHighlightedIndex(-1)
      return
    }

    const selectedIndex = filteredSuggestions.findIndex((font) => font === value)
    setHighlightedIndex(Math.max(selectedIndex, 0))
  }, [filteredSuggestions, open, value])

  useEffect(() => {
    if (!open || highlightedIndex < 0) {
      return
    }

    const highlightedFont = filteredSuggestions[highlightedIndex]
    if (!highlightedFont) {
      return
    }

    optionRefs.current.get(highlightedFont)?.scrollIntoView({ block: 'nearest' })
  }, [filteredSuggestions, highlightedIndex, open])

  const commitValue = (nextValue: string): void => {
    setQuery(nextValue)
    onChange(nextValue)
    setOpen(false)
  }

  const focusInput = (): void => {
    inputRef.current?.focus()
  }

  return (
    <div ref={rootRef} className="relative max-w-sm">
      <div className="relative">
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            const next = e.target.value
            setQuery(next)
            onChange(next)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (open) {
                e.preventDefault()
                setOpen(false)
              }
              return
            }

            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setOpen(true)
              if (filteredSuggestions.length > 0) {
                setHighlightedIndex((current) =>
                  current < 0 ? 0 : Math.min(current + 1, filteredSuggestions.length - 1)
                )
              }
              return
            }

            if (e.key === 'ArrowUp') {
              e.preventDefault()
              setOpen(true)
              if (filteredSuggestions.length > 0) {
                setHighlightedIndex((current) =>
                  current < 0 ? filteredSuggestions.length - 1 : Math.max(current - 1, 0)
                )
              }
              return
            }

            if (e.key === 'Enter' && open && highlightedIndex >= 0) {
              const highlightedFont = filteredSuggestions[highlightedIndex]
              if (highlightedFont) {
                e.preventDefault()
                commitValue(highlightedFont)
              }
            }
          }}
          placeholder="SF Mono"
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
                onChange('')
                setOpen(true)
                focusInput()
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
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const nextOpen = !open
              setOpen(nextOpen)
              if (nextOpen) {
                focusInput()
              }
            }}
            className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label="Toggle font suggestions"
            title="Fonts"
          >
            <ChevronsUpDown className="size-3.5" />
          </button>
        </div>
      </div>

      {open ? (
        <div className="absolute top-full z-20 mt-2 w-full overflow-hidden rounded-md border border-border/50 bg-popover shadow-md">
          <ScrollArea className={filteredSuggestions.length > 8 ? 'h-64' : undefined}>
            <div id={listboxId} role="listbox" className="p-1">
              {filteredSuggestions.length > 0 ? (
                filteredSuggestions.map((font, index) => (
                  <button
                    key={font}
                    type="button"
                    id={`${listboxId}-option-${index}`}
                    role="option"
                    aria-selected={index === highlightedIndex}
                    ref={(element) => {
                      if (element) {
                        optionRefs.current.set(font, element)
                        return
                      }
                      optionRefs.current.delete(font)
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
                <div className="px-3 py-3 text-sm text-muted-foreground">No matching fonts.</div>
              )}
            </div>
          </ScrollArea>
        </div>
      ) : null}
    </div>
  )
}

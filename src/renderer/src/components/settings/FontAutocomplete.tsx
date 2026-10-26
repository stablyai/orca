import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown, CircleX } from 'lucide-react'
import { Input } from '../ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '../ui/popover'
import { ScrollArea } from '../ui/scroll-area'
import { filterFontSuggestions, getRenderedFontSuggestions } from './settings-form-option-filter'
import { translate } from '@/i18n/i18n'

type FontAutocompleteProps = {
  value: string
  suggestions: string[]
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
  disabled?: boolean
  commitMode?: 'change' | 'blur'
  defaultOptionLabel?: string
  onRequestSuggestions?: () => void
  /** Preview the highlighted font without committing; null clears the preview when nothing is highlighted or the menu closes. */
  onPreviewFontFamily?: (font: string | null) => void
}

export function FontAutocomplete({
  value,
  suggestions,
  onChange,
  placeholder = 'SF Mono',
  ariaLabel,
  disabled = false,
  commitMode = 'change',
  defaultOptionLabel,
  onRequestSuggestions,
  onPreviewFontFamily
}: FontAutocompleteProps): React.JSX.Element {
  const [query, setQuery] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  const [open, setOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const [isFilteringQuery, setIsFilteringQuery] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastCommittedValueRef = useRef(value)
  const previewFontFamilyRef = useRef(onPreviewFontFamily)
  const listboxId = useId()

  useEffect(() => {
    previewFontFamilyRef.current = onPreviewFontFamily
  }, [onPreviewFontFamily])

  const setRootNode = useCallback((element: HTMLDivElement | null): void => {
    rootRef.current = element
    if (!element) {
      // Search can unmount a previewing control; clear the consumer’s transient font on detach.
      previewFontFamilyRef.current?.(null)
    }
  }, [])

  if (value !== prevValue) {
    setPrevValue(value)
    lastCommittedValueRef.current = value
    setQuery(value)
    if (value !== query) {
      setIsFilteringQuery(false)
    }
  }
  if (disabled && open) {
    setOpen(false)
    setQuery(value)
    setIsFilteringQuery(false)
  }

  const requestSuggestions = useCallback((): void => {
    onRequestSuggestions?.()
  }, [onRequestSuggestions])

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    if (nextOpen) {
      requestSuggestions()
    }
    if (!nextOpen) {
      setIsFilteringQuery(false)
    }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const normalizedValue = value.trim().toLowerCase()
  const allSuggestions = useMemo(() => {
    if (!defaultOptionLabel) {
      return suggestions
    }
    const fonts = suggestions.filter(Boolean)
    if (value && !fonts.includes(value)) {
      fonts.push(value)
    }
    return ['', ...fonts]
  }, [defaultOptionLabel, suggestions, value])
  const filteredSuggestions = useMemo(
    () => filterFontSuggestions(allSuggestions, query, defaultOptionLabel),
    [allSuggestions, query, defaultOptionLabel]
  )
  // Opening with the committed font must still show all fonts rather than filter by its name.
  const visibleSuggestions =
    !isFilteringQuery && normalizedQuery === normalizedValue ? allSuggestions : filteredSuggestions
  const renderedSuggestions = useMemo(
    () => getRenderedFontSuggestions(visibleSuggestions, highlightedIndex),
    [visibleSuggestions, highlightedIndex]
  )

  // Reconcile highlights before paint so opening/filter changes cannot flash a stale index.
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
      const selectedIndex = visibleSuggestions.indexOf(value)
      setHighlightedIndex(Math.max(selectedIndex, 0))
    }
  }

  // Preview the highlight; closing or leaving options restores the committed font.
  useEffect(() => {
    if (!onPreviewFontFamily) {
      return
    }
    if (!open || disabled) {
      onPreviewFontFamily(null)
      return
    }
    onPreviewFontFamily(
      highlightedIndex >= 0
        ? (visibleSuggestions[highlightedIndex] ?? null)
        : commitMode === 'blur'
          ? query.trim()
          : null
    )
  }, [visibleSuggestions, highlightedIndex, onPreviewFontFamily, open, disabled, commitMode, query])

  const commitValue = (nextValue: string): void => {
    const trimmed = commitMode === 'blur' ? nextValue.trim() : nextValue
    const committed =
      defaultOptionLabel && trimmed.toLowerCase() === defaultOptionLabel.trim().toLowerCase()
        ? ''
        : trimmed
    setQuery(committed)
    setIsFilteringQuery(false)
    if (commitMode === 'change' || committed !== lastCommittedValueRef.current) {
      lastCommittedValueRef.current = committed
      onChange(committed)
    }
    setOpen(false)
  }

  const focusInput = (): void => {
    inputRef.current?.focus()
  }
  const popoverAvailableHeightStyle = {
    // Why: tailwind-merge rewrites this arbitrary max-height class on the
    // ScrollArea root, so keep the Radix available-height clamp as inline style.
    maxHeight: 'var(--radix-popover-content-available-height)'
  } as React.CSSProperties

  return (
    <div ref={setRootNode} className="relative max-w-sm">
      <Popover open={open && !disabled} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <div className="relative">
            <Input
              ref={inputRef}
              value={query}
              disabled={disabled}
              aria-label={ariaLabel}
              onChange={(e) => {
                const next = e.target.value
                requestSuggestions()
                setQuery(next)
                setIsFilteringQuery(true)
                if (commitMode === 'change') {
                  onChange(next)
                }
                setOpen(true)
              }}
              onFocus={() => {
                requestSuggestions()
                setIsFilteringQuery(false)
                setOpen(true)
              }}
              onBlur={() => {
                if (commitMode === 'blur' && !disabled) {
                  commitValue(query)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  if (commitMode === 'blur') {
                    setQuery(lastCommittedValueRef.current)
                  }
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

                if (e.key === 'Enter' && e.nativeEvent.isComposing) {
                  return
                }

                if (e.key === 'Enter' && open && highlightedIndex >= 0) {
                  const highlightedFont = visibleSuggestions[highlightedIndex]
                  if (highlightedFont !== undefined) {
                    e.preventDefault()
                    commitValue(highlightedFont)
                  }
                } else if (e.key === 'Enter' && commitMode === 'blur') {
                  e.preventDefault()
                  commitValue(query)
                }
              }}
              placeholder={placeholder}
              className="pr-18"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={listboxId}
              aria-activedescendant={
                open && highlightedIndex >= 0
                  ? `${listboxId}-option-${highlightedIndex}`
                  : undefined
              }
            />
            <div className="absolute inset-y-0 right-2 flex items-center gap-1">
              {query ? (
                <button
                  type="button"
                  disabled={disabled}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    commitValue('')
                    setOpen(true)
                    focusInput()
                  }}
                  className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={translate(
                    'auto.components.settings.SettingsFormControls.a4ff6143f8',
                    'Clear font selection'
                  )}
                  title={translate(
                    'auto.components.settings.SettingsFormControls.74bcecd5ec',
                    'Clear'
                  )}
                >
                  <CircleX className="size-3.5" />
                </button>
              ) : null}
              <button
                type="button"
                disabled={disabled}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  const nextOpen = !open
                  setOpen(nextOpen)
                  if (!nextOpen) {
                    setIsFilteringQuery(false)
                  }
                  if (nextOpen) {
                    requestSuggestions()
                    focusInput()
                  }
                }}
                className="rounded-sm p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label={translate(
                  'auto.components.settings.SettingsFormControls.c766f8ac75',
                  'Toggle font suggestions'
                )}
                title={translate(
                  'auto.components.settings.SettingsFormControls.b55371ea18',
                  'Fonts'
                )}
              >
                <ChevronsUpDown className="size-3.5" />
              </button>
            </div>
          </div>
        </PopoverAnchor>

        {/* Portal outside Settings so option scrollIntoView cannot scroll the whole pane away. */}
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)]"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // The input/buttons are anchors outside content; prevent Radix from dismissing on those clicks.
            if (rootRef.current?.contains(e.target as Node)) {
              e.preventDefault()
            }
          }}
        >
          <ScrollArea
            className={renderedSuggestions.length > 8 ? 'h-64' : undefined}
            style={popoverAvailableHeightStyle}
            viewportProps={{ style: popoverAvailableHeightStyle }}
          >
            <div id={listboxId} role="listbox" className="p-1">
              {visibleSuggestions.length > 0 ? (
                renderedSuggestions.map(({ font, sourceIndex }) => (
                  <button
                    key={font}
                    type="button"
                    id={`${listboxId}-option-${sourceIndex}`}
                    role="option"
                    aria-selected={sourceIndex === highlightedIndex}
                    ref={(element) => {
                      if (element && sourceIndex === highlightedIndex) {
                        element.scrollIntoView({ block: 'nearest' })
                      }
                    }}
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseEnter={() => setHighlightedIndex(sourceIndex)}
                    onClick={() => commitValue(font)}
                    className={`flex w-full items-center justify-between rounded-sm px-3 py-2 text-left text-sm transition-colors ${
                      sourceIndex === highlightedIndex
                        ? 'bg-accent text-accent-foreground'
                        : 'hover:bg-muted/60'
                    }`}
                  >
                    <span className="truncate">{font || defaultOptionLabel}</span>
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
        </PopoverContent>
      </Popover>
    </div>
  )
}

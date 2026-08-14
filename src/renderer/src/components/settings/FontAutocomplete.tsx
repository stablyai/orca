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
  onRequestSuggestions?: () => void
  /** Fires with whichever option the user is currently highlighting in the
   *  dropdown (via mouse hover or keyboard arrow), or null when nothing is
   *  highlighted / the dropdown is closed. Lets a consumer show a live
   *  preview of the font without committing the selection. */
  onPreviewFontFamily?: (font: string | null) => void
}

export function FontAutocomplete({
  value,
  suggestions,
  onChange,
  placeholder = 'SF Mono',
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
  const previewFontFamilyRef = useRef(onPreviewFontFamily)
  const listboxId = useId()

  useEffect(() => {
    previewFontFamilyRef.current = onPreviewFontFamily
  }, [onPreviewFontFamily])

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
  const filteredSuggestions = useMemo(
    () => filterFontSuggestions(suggestions, query),
    [suggestions, query]
  )
  // Why: the committed font fills the input, but opening the chooser should
  // still reveal every installed font instead of only fonts sharing that name.
  const visibleSuggestions =
    !isFilteringQuery && normalizedQuery === normalizedValue ? suggestions : filteredSuggestions
  const renderedSuggestions = useMemo(
    () => getRenderedFontSuggestions(visibleSuggestions, highlightedIndex),
    [visibleSuggestions, highlightedIndex]
  )

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
      const selectedIndex = visibleSuggestions.indexOf(value)
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
  const popoverAvailableHeightStyle = {
    // Why: tailwind-merge rewrites this arbitrary max-height class on the
    // ScrollArea root, so keep the Radix available-height clamp as inline style.
    maxHeight: 'var(--radix-popover-content-available-height)'
  } as React.CSSProperties

  return (
    <div ref={setRootNode} className="relative max-w-sm">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverAnchor asChild>
          <div className="relative">
            <Input
              ref={inputRef}
              value={query}
              onChange={(e) => {
                const next = e.target.value
                requestSuggestions()
                setQuery(next)
                setIsFilteringQuery(true)
                onChange(next)
                setOpen(true)
              }}
              onFocus={() => {
                requestSuggestions()
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
                open && highlightedIndex >= 0
                  ? `${listboxId}-option-${highlightedIndex}`
                  : undefined
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

        {/* Why: portal the dropdown outside the settings section — an in-flow
          absolute panel makes the highlighted option's scrollIntoView scroll
          the whole settings pane, pushing the section content out of view. */}
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)]"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            // Why: the input and its clear/toggle buttons are the anchor, not
            // the content, so Radix would otherwise dismiss on every click there.
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
        </PopoverContent>
      </Popover>
    </div>
  )
}

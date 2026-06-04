/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: dropdown visibility depends on DOM focus plus browser-history suggestions, so the close path is an imperative popover sync. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { useAppStore } from '@/store'
import { DEFAULT_SEARCH_ENGINE, type SearchEngine } from '../../../../shared/browser-url'
import { buildBrowserAddressBarSuggestions } from './browser-address-bar-suggestions'

type BrowserAddressBarProps = {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onNavigate: (url: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}

export default function BrowserAddressBar({
  value,
  onChange,
  onSubmit,
  onNavigate,
  inputRef
}: BrowserAddressBarProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [selectedValueOverride, setSelectedValueOverride] = useState<string | null>(null)
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const browserDefaultSearchEngine = useAppStore((s) => s.browserDefaultSearchEngine)
  const browserKagiSessionLink = useAppStore((s) => s.browserKagiSessionLink)
  const closingRef = useRef(false)
  const openedAtRef = useRef(0)
  const blurCloseTimerRef = useRef<number | null>(null)
  const closingResetTimerRef = useRef<number | null>(null)

  const clearAddressBarTimers = useCallback((): void => {
    if (blurCloseTimerRef.current !== null) {
      window.clearTimeout(blurCloseTimerRef.current)
      blurCloseTimerRef.current = null
    }
    if (closingResetTimerRef.current !== null) {
      window.clearTimeout(closingResetTimerRef.current)
      closingResetTimerRef.current = null
    }
  }, [])

  const setAddressBarFormRef = useCallback(
    (node: HTMLFormElement | null) => {
      if (node === null) {
        clearAddressBarTimers()
      }
    },
    [clearAddressBarTimers]
  )

  const searchEngine: SearchEngine =
    (browserDefaultSearchEngine as SearchEngine | null) ?? DEFAULT_SEARCH_ENGINE

  const suggestions = useMemo(
    () =>
      buildBrowserAddressBarSuggestions({
        browserUrlHistory,
        kagiSessionLink: browserKagiSessionLink,
        searchEngine,
        value
      }),
    [browserUrlHistory, value, searchEngine, browserKagiSessionLink]
  )

  const selectedValue =
    selectedValueOverride &&
    suggestions.some((suggestion) => suggestion.url === selectedValueOverride)
      ? selectedValueOverride
      : (suggestions[0]?.url ?? '')

  const handleFocus = useCallback(() => {
    if (closingRef.current) {
      return
    }
    if (blurCloseTimerRef.current !== null) {
      window.clearTimeout(blurCloseTimerRef.current)
      blurCloseTimerRef.current = null
    }
    inputRef.current?.select()
    openedAtRef.current = Date.now()
    setOpen(true)
  }, [inputRef])

  const handleBlur = useCallback(() => {
    // Why: delay close so that clicking a suggestion item registers before
    // the popover unmounts. Without this, onSelect never fires because the
    // mousedown on PopoverContent triggers input blur first.
    //
    // Why (grace window): BrowserPane's focusAddressBarNow() retries focus
    // across multiple animation frames to fight webview focus stealing. Each
    // cycle can cause a transient blur on the input. Without this guard the
    // popover opens on focus, immediately gets a blur, and closes ~150ms later
    // — producing the "flash then disappear" on first click.
    const elapsed = Date.now() - openedAtRef.current
    const grace = elapsed < 400
    if (blurCloseTimerRef.current !== null) {
      window.clearTimeout(blurCloseTimerRef.current)
    }
    blurCloseTimerRef.current = window.setTimeout(() => {
      blurCloseTimerRef.current = null
      if (grace && inputRef.current && document.activeElement === inputRef.current) {
        return
      }
      setOpen(false)
    }, 200)
  }, [inputRef])

  const handleSelect = useCallback(
    (url: string) => {
      closingRef.current = true
      setOpen(false)
      setSelectedValueOverride(null)
      onNavigate(url)
      if (closingResetTimerRef.current !== null) {
        window.clearTimeout(closingResetTimerRef.current)
      }
      closingResetTimerRef.current = window.setTimeout(() => {
        closingResetTimerRef.current = null
        closingRef.current = false
      }, 100)
    },
    [onNavigate]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setSelectedValueOverride(null)
        return
      }

      if (!open || suggestions.length === 0) {
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        const idx = suggestions.findIndex((s) => s.url === selectedValue)
        const next = idx < suggestions.length - 1 ? idx + 1 : 0
        setSelectedValueOverride(suggestions[next].url)
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        const idx = suggestions.findIndex((s) => s.url === selectedValue)
        const next = idx > 0 ? idx - 1 : suggestions.length - 1
        setSelectedValueOverride(suggestions[next].url)
        return
      }

      if (event.key === 'Enter' && selectedValue) {
        const match = suggestions.find((s) => s.url === selectedValue)
        if (match) {
          event.preventDefault()
          handleSelect(match.url)
        }
      }
    },
    [open, suggestions, selectedValue, handleSelect]
  )

  // Why: close the dropdown only when the input has lost focus AND there are
  // no suggestions. Previously this closed unconditionally on empty suggestions,
  // which caused the dropdown to vanish mid-typing when backspacing produced a
  // query that didn't match any history entries. Keeping the popover open while
  // focused lets the user continue editing and see results reappear.
  useEffect(() => {
    if (open && suggestions.length === 0) {
      if (inputRef.current && document.activeElement === inputRef.current) {
        return
      }
      setOpen(false)
    }
  }, [open, suggestions.length, inputRef])

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Why: Radix fires onOpenChange(false) when it detects an outside
        // interaction, but during the focus-retry loop the input may still
        // hold focus. Only allow programmatic closes (setOpen(false) from
        // our handlers) or genuine outside dismissals.
        if (!next && inputRef.current && document.activeElement === inputRef.current) {
          return
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <form
          ref={setAddressBarFormRef}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-background px-3 py-1 shadow-sm"
          onSubmit={(event) => {
            event.preventDefault()
            setOpen(false)
            onSubmit()
          }}
        >
          <Globe className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={value}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            data-orca-browser-address-bar="true"
            className="h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            onChange={(event) => {
              // Why: typing creates a new suggestion list, so keyboard selection
              // should return to the derived top match instead of a stale row.
              setSelectedValueOverride(null)
              onChange(event.target.value)
            }}
            role="combobox"
            aria-expanded={open}
            aria-controls="browser-history-listbox"
            aria-autocomplete="list"
          />
        </form>
      </PopoverTrigger>
      {suggestions.length > 0 && (
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] p-0"
          onOpenAutoFocus={(e) => {
            // Why: prevent the popover from stealing focus away from the
            // address bar input. The user is still typing; the popover is
            // an overlay of suggestions, not a focus target.
            e.preventDefault()
          }}
        >
          <Command
            shouldFilter={false}
            value={selectedValue}
            onValueChange={setSelectedValueOverride}
          >
            <CommandList id="browser-history-listbox" role="listbox">
              <CommandGroup>
                {suggestions.map((entry) => (
                  <CommandItem
                    key={entry.url}
                    value={entry.url}
                    onSelect={() => handleSelect(entry.url)}
                    className="flex items-center gap-2 px-3 py-2"
                  >
                    {entry.isSearch ? (
                      <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm">{entry.title}</span>
                      {entry.subtitle ? (
                        <span className="truncate text-xs text-muted-foreground">
                          {entry.subtitle}
                        </span>
                      ) : null}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      )}
    </Popover>
  )
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Globe, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { useAppStore } from '@/store'
import {
  buildSearchUrl,
  looksLikeSearchQuery,
  normalizeBrowserNavigationUrl,
  SEARCH_ENGINE_LABELS,
  DEFAULT_SEARCH_ENGINE,
  type SearchEngine
} from '../../../../shared/browser-url'

const MAX_SUGGESTIONS = 8

type SuggestionEntry = {
  url: string
  title: string
  subtitle: string
  lastVisitedAt: number
  visitCount: number
  isSearch: boolean
}

type BrowserAddressBarProps = {
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onNavigate: (url: string) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}

function scoreSuggestion(
  entry: { url: string; title: string; lastVisitedAt: number; visitCount: number },
  query: string
): number {
  const lowerQuery = query.toLowerCase()
  const lowerUrl = entry.url.toLowerCase()
  const lowerTitle = entry.title.toLowerCase()

  if (!lowerUrl.includes(lowerQuery) && !lowerTitle.includes(lowerQuery)) {
    return -1
  }

  let score = 0
  if (lowerUrl.startsWith(lowerQuery) || lowerUrl.startsWith(`https://${lowerQuery}`)) {
    score += 100
  }
  score += Math.min(entry.visitCount, 50)
  const ageHours = (Date.now() - entry.lastVisitedAt) / (1000 * 60 * 60)
  score += Math.max(0, 24 - ageHours)
  return score
}

export default function BrowserAddressBar({
  value,
  onChange,
  onSubmit,
  onNavigate,
  inputRef
}: BrowserAddressBarProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [selectedValue, setSelectedValue] = useState('')
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const browserDefaultSearchEngine = useAppStore((s) => s.browserDefaultSearchEngine)
  const closingRef = useRef(false)
  const openedAtRef = useRef(0)

  const searchEngine: SearchEngine =
    (browserDefaultSearchEngine as SearchEngine | null) ?? DEFAULT_SEARCH_ENGINE

  const suggestions = useMemo((): SuggestionEntry[] => {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('data:')) {
      if (browserUrlHistory.length === 0) {
        return []
      }
      return [...browserUrlHistory]
        .sort((a, b) => b.lastVisitedAt - a.lastVisitedAt)
        .slice(0, MAX_SUGGESTIONS)
        .map((entry) => ({ ...entry, subtitle: entry.url, isSearch: false }))
    }

    const historySuggestions: SuggestionEntry[] =
      browserUrlHistory.length > 0
        ? browserUrlHistory
            .map((entry) => ({ entry, score: scoreSuggestion(entry, trimmed) }))
            .filter((item) => item.score >= 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, MAX_SUGGESTIONS - 1)
            .map((item) => ({ ...item.entry, subtitle: item.entry.url, isSearch: false }))
        : []

    // Why: the top row of the dropdown must always mirror what pressing Enter
    // will do — i.e. what `normalizeBrowserNavigationUrl` resolves to. Chrome
    // and Firefox omniboxes work this way: for URL-like inputs the top row is
    // the typed URL itself (navigate), and for bare queries it is the search.
    // The earlier implementation appended a "Google Search" row as a fallback
    // for URL-like inputs, which then got auto-selected when no history
    // matched — so Enter on "www.example.com" hit Google instead of the site.
    const isQuery = looksLikeSearchQuery(trimmed)
    const topAction: SuggestionEntry = isQuery
      ? {
          url: buildSearchUrl(trimmed, searchEngine),
          title: trimmed,
          subtitle: `${SEARCH_ENGINE_LABELS[searchEngine]} Search`,
          lastVisitedAt: 0,
          visitCount: 0,
          isSearch: true
        }
      : {
          url: normalizeBrowserNavigationUrl(trimmed, searchEngine) ?? trimmed,
          title: trimmed,
          subtitle: '',
          lastVisitedAt: 0,
          visitCount: 0,
          isSearch: false
        }

    // Why: if a history row already targets the same URL as the top action,
    // skip the synthetic top row — the history row is more informative (real
    // page title) and will be auto-selected, so Enter still navigates to the
    // same place.
    const duplicateIdx = historySuggestions.findIndex((h) => h.url === topAction.url)
    if (duplicateIdx >= 0) {
      return historySuggestions.slice(0, MAX_SUGGESTIONS)
    }

    return [topAction, ...historySuggestions].slice(0, MAX_SUGGESTIONS)
  }, [browserUrlHistory, value, searchEngine])

  const handleFocus = useCallback(() => {
    if (closingRef.current) {
      return
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
    setTimeout(() => {
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
      onNavigate(url)
      setTimeout(() => {
        closingRef.current = false
      }, 100)
    },
    [onNavigate]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        setOpen(false)
        setSelectedValue('')
        return
      }

      if (!open || suggestions.length === 0) {
        return
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelectedValue((prev) => {
          const idx = suggestions.findIndex((s) => s.url === prev)
          const next = idx < suggestions.length - 1 ? idx + 1 : 0
          return suggestions[next].url
        })
        return
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelectedValue((prev) => {
          const idx = suggestions.findIndex((s) => s.url === prev)
          const next = idx > 0 ? idx - 1 : suggestions.length - 1
          return suggestions[next].url
        })
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

  // Why: auto-select the top suggestion so Enter navigates to the best match
  // without an extra ArrowDown. Fall back to clearing selection when nothing
  // matches so stale highlights don't persist.
  useEffect(() => {
    setSelectedValue(suggestions[0]?.url ?? '')
  }, [suggestions])

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
            onChange={(event) => onChange(event.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            data-orca-browser-address-bar="true"
            className="h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
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
          <Command shouldFilter={false} value={selectedValue} onValueChange={setSelectedValue}>
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

import { useEffect, useState, useCallback } from 'react'
import { ChevronUp, ChevronDown, X, CaseSensitive, Regex } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'
import { Button } from '@/components/ui/button'
import type { SearchState } from '@/components/terminal-pane/keyboard-handlers'
import { translate } from '@/i18n/i18n'
import { getFindRequestQuery } from '@/lib/find-query-bounds'
import { safeFind } from './terminal-search-safe-find'
import {
  TERMINAL_SEARCH_HIGHLIGHT_LIMIT,
  buildTerminalSearchOptions
} from './terminal-search-options'

type TerminalSearchProps = {
  isOpen: boolean
  onClose: () => void
  searchAddon: SearchAddon | null
  searchStateRef: React.RefObject<SearchState>
}

type MatchCount = { addon: SearchAddon; query: string | null; index: number; count: number }

/**
 * Renders the find bar's match counter.
 *
 * The addon reports index -1 when the selected match is not among the tracked
 * results — past `highlightLimit`, or before a match is selected — so a position
 * is unknowable there and only the (capped) total can be shown.
 *
 * @param matches The position and total last reported by `onDidChangeResults`.
 * @returns `3/47`, `0/0`, a bare total, or `1000+` once the total is truncated.
 */
function formatMatchCount(matches: { index: number; count: number }): string {
  if (matches.count === 0) {
    return '0/0'
  }
  if (matches.index < 0) {
    return matches.count >= TERMINAL_SEARCH_HIGHLIGHT_LIMIT
      ? `${matches.count}+`
      : `${matches.count}`
  }
  return `${matches.index + 1}/${matches.count}`
}

/**
 * Drops every trace of the current search from a pane's addon.
 *
 * @param searchAddon The pane's addon, or null when no pane is attached.
 */
function clearTerminalSearch(searchAddon: SearchAddon | null): void {
  if (!searchAddon) {
    return
  }
  searchAddon.clearDecorations()
  // Why: xterm keeps the active match selected after decorations are cleared.
  searchAddon.findNext('')
}

/**
 * The terminal find bar: query input, case/regex toggles, match navigation, and
 * a counter spanning the whole scrollback.
 *
 * @param props.isOpen Whether the bar is showing; closing clears the search.
 * @param props.onClose Invoked on Escape and on the close button.
 * @param props.searchAddon The focused pane's addon; changes on a pane switch.
 * @param props.searchStateRef Written on every change so the Cmd+G / Ctrl+G
 * handler can navigate without this state being lifted to the parent.
 * @returns The find bar, or null while closed.
 */
export default function TerminalSearch({
  isOpen,
  onClose,
  searchAddon,
  searchStateRef
}: TerminalSearchProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  // Why surfaced: the count spans the whole scrollback, so it is the only signal
  // that matches exist above the visible screen. Tagged with the addon and query
  // it was reported for, so a pane switch or an edited query invalidates it in
  // render rather than through a state reset the user would see one frame late.
  const [matches, setMatches] = useState<MatchCount | null>(null)
  const requestQuery = getFindRequestQuery(query)
  const currentMatches =
    matches && matches.addon === searchAddon && matches.query === requestQuery ? matches : null

  const searchOptions = useCallback(
    (incremental: boolean = false) =>
      buildTerminalSearchOptions({ caseSensitive, regex, incremental }),
    [caseSensitive, regex]
  )

  const findNext = useCallback(() => {
    if (searchAddon && requestQuery) {
      safeFind(
        (term, options) => searchAddon.findNext(term, options),
        requestQuery,
        searchOptions()
      )
    }
  }, [searchAddon, requestQuery, searchOptions])

  const findPrevious = useCallback(() => {
    if (searchAddon && requestQuery) {
      safeFind(
        (term, options) => searchAddon.findPrevious(term, options),
        requestQuery,
        searchOptions()
      )
    }
  }, [searchAddon, requestQuery, searchOptions])

  const handleInputRef = useCallback((input: HTMLInputElement | null): void => {
    input?.focus()
  }, [])

  useEffect(
    () => () => {
      clearTerminalSearch(searchAddon)
    },
    [searchAddon]
  )

  // Declared before the search effect so a pane switch or an edited query is
  // subscribed before that effect issues its first find, and so the listener
  // closes over the query its results belong to.
  useEffect(() => {
    if (!searchAddon) {
      return
    }
    const subscription = searchAddon.onDidChangeResults(({ resultIndex, resultCount }) => {
      setMatches({
        addon: searchAddon,
        query: requestQuery,
        index: resultIndex,
        count: resultCount
      })
    })
    return () => subscription.dispose()
  }, [searchAddon, requestQuery])

  useEffect(() => {
    // Keep the ref in sync so the keyboard handler (Cmd+G / Cmd+Shift+G)
    // can read the current search state without lifting it to parent state.
    searchStateRef.current = { query: requestQuery ?? '', caseSensitive, regex }

    if (!isOpen || !requestQuery) {
      clearTerminalSearch(searchAddon)
      return
    }
    if (searchAddon) {
      safeFind(
        (term, options) => searchAddon.findNext(term, options),
        requestQuery,
        searchOptions(true)
      )
    }
  }, [requestQuery, searchAddon, isOpen, caseSensitive, regex, searchStateRef, searchOptions])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      e.stopPropagation()

      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'Enter' && e.shiftKey) {
        findPrevious()
      } else if (e.key === 'Enter') {
        findNext()
      }
    },
    [onClose, findNext, findPrevious]
  )

  if (!isOpen) {
    return null
  }

  return (
    <div
      data-terminal-search-root
      className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border border-zinc-700 bg-zinc-800/95 px-2 py-1 shadow-lg backdrop-blur-sm"
      style={{ width: 300 }}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={handleInputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={translate('auto.components.TerminalSearch.e07012f26e', 'Search...')}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-white outline-none placeholder:text-zinc-500"
      />

      {requestQuery && currentMatches ? (
        <span
          data-terminal-search-match-count
          className={`shrink-0 text-xs tabular-nums ${
            currentMatches.count === 0 ? 'text-red-400' : 'text-zinc-400'
          }`}
        >
          {formatMatchCount(currentMatches)}
        </span>
      ) : null}

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setCaseSensitive((v) => !v)}
        className={`flex size-6 shrink-0 items-center justify-center rounded ${
          caseSensitive ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        title={translate('auto.components.TerminalSearch.90c61387d9', 'Case sensitive')}
      >
        <CaseSensitive size={14} />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={() => setRegex((v) => !v)}
        className={`flex size-6 shrink-0 items-center justify-center rounded ${
          regex ? 'bg-zinc-700/50 text-blue-400' : 'text-zinc-400 hover:text-zinc-200'
        }`}
        title={translate('auto.components.TerminalSearch.42e466b9f1', 'Regex')}
      >
        <Regex size={14} />
      </Button>

      <div className="mx-0.5 h-4 w-px bg-zinc-700" />

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findPrevious}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title={translate('auto.components.TerminalSearch.0f3066256e', 'Previous match')}
      >
        <ChevronUp size={14} />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findNext}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title={translate('auto.components.TerminalSearch.7cb40c04eb', 'Next match')}
      >
        <ChevronDown size={14} />
      </Button>

      <div className="mx-0.5 h-4 w-px bg-zinc-700" />

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        className="flex size-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:text-zinc-200"
        title={translate('auto.components.TerminalSearch.db234b7519', 'Close')}
      >
        <X size={14} />
      </Button>
    </div>
  )
}

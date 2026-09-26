import { useEffect, useState, useCallback } from 'react'
import { ChevronUp, ChevronDown, X, CaseSensitive, Regex } from 'lucide-react'
import type { SearchAddon } from '@xterm/addon-search'
import { Button } from '@/components/ui/button'
import type { SearchState } from '@/components/terminal-pane/keyboard-handlers'
import { translate } from '@/i18n/i18n'
import { getFindRequestQuery } from '@/lib/find-query-bounds'
import { safeFind } from './terminal-search-safe-find'

type TerminalSearchProps = {
  isOpen: boolean
  onClose: () => void
  searchAddon: SearchAddon | null
  searchStateRef: React.RefObject<SearchState>
  inputRef?: React.RefObject<HTMLInputElement | null>
}

// xterm uses index -1 when results exceed its highlight limit.
const EMPTY_RESULTS = { resultIndex: -1, resultCount: 0 }

function clearTerminalSearch(searchAddon: SearchAddon | null): void {
  if (!searchAddon) {
    return
  }
  searchAddon.clearDecorations()
  // Why: xterm keeps the active match selected after decorations are cleared.
  searchAddon.findNext('')
}

export default function TerminalSearch({
  isOpen,
  onClose,
  searchAddon,
  searchStateRef,
  inputRef
}: TerminalSearchProps): React.JSX.Element | null {
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [results, setResults] = useState(EMPTY_RESULTS)
  const requestQuery = getFindRequestQuery(query)

  // xterm needs hex colors; explicit highlights stay visible over terminal themes (#612).
  const searchOptions = useCallback(
    (incremental: boolean = false) => ({
      caseSensitive,
      regex,
      incremental,
      decorations: {
        matchBackground: '#5c4a00',
        matchBorder: '#5c4a00',
        matchOverviewRuler: '#ffcc00',
        activeMatchBackground: '#c4580e',
        activeMatchBorder: '#ffcf6b',
        activeMatchColorOverviewRuler: '#ff9900'
      }
    }),
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

  const handleInputRef = useCallback(
    (input: HTMLInputElement | null): void => {
      if (inputRef) {
        inputRef.current = input
      }
      input?.focus()
      input?.select()
    },
    [inputRef]
  )

  // One addon subscription tracks both panel and keyboard navigation.
  useEffect(() => {
    if (!searchAddon) {
      return
    }
    const disposable = searchAddon.onDidChangeResults(setResults)
    return () => {
      disposable.dispose()
      clearTerminalSearch(searchAddon)
    }
  }, [searchAddon])

  useEffect(() => {
    // Global match-navigation shortcuts read the same query as the panel.
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

  const matchStatus = !requestQuery
    ? '0/0'
    : results.resultCount === 0
      ? translate('auto.components.TerminalSearch.10e039b591', 'No results')
      : results.resultIndex === -1
        ? `${results.resultCount}+`
        : `${results.resultIndex + 1}/${results.resultCount}`

  return (
    <div
      data-terminal-search-root
      className="absolute top-2 right-2 z-50 flex items-center gap-1 rounded-lg border border-border bg-popover/95 px-2 py-1 text-popover-foreground shadow-floating backdrop-blur-sm"
      style={{ width: 340, maxWidth: 'calc(100% - 16px)' }}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={handleInputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={translate('auto.components.TerminalSearch.e07012f26e', 'Search...')}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-popover-foreground outline-none placeholder:text-muted-foreground"
      />

      <Button
        type="button"
        variant={caseSensitive ? 'secondary' : 'ghost'}
        size="icon-xs"
        aria-pressed={caseSensitive}
        onClick={() => setCaseSensitive((v) => !v)}
        className="shrink-0"
        title={translate('auto.components.TerminalSearch.90c61387d9', 'Case sensitive')}
      >
        <CaseSensitive size={14} />
      </Button>

      <Button
        type="button"
        variant={regex ? 'secondary' : 'ghost'}
        size="icon-xs"
        aria-pressed={regex}
        onClick={() => setRegex((v) => !v)}
        className="shrink-0"
        title={translate('auto.components.TerminalSearch.42e466b9f1', 'Regex')}
      >
        <Regex size={14} />
      </Button>

      <span className="shrink-0 whitespace-nowrap px-1 text-xs tabular-nums text-muted-foreground">
        {matchStatus}
      </span>

      <div className="mx-0.5 h-4 w-px bg-border" />

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findPrevious}
        className="shrink-0"
        title={translate('auto.components.TerminalSearch.0f3066256e', 'Previous match')}
      >
        <ChevronUp size={14} />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={findNext}
        className="shrink-0"
        title={translate('auto.components.TerminalSearch.7cb40c04eb', 'Next match')}
      >
        <ChevronDown size={14} />
      </Button>

      <div className="mx-0.5 h-4 w-px bg-border" />

      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        onClick={onClose}
        className="shrink-0"
        title={translate('auto.components.TerminalSearch.db234b7519', 'Close')}
      >
        <X size={14} />
      </Button>
    </div>
  )
}

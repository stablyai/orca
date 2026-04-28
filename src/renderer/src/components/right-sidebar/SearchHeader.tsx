import React from 'react'
import { Search as SearchIcon, CaseSensitive, WholeWord, Regex, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SearchFilters } from './SearchFilters'
import { ToggleButton } from './SearchResultItems'

type SearchHeaderProps = {
  inputRef: React.RefObject<HTMLInputElement | null>
  includeInputRef: React.RefObject<HTMLInputElement | null>
  excludeInputRef: React.RefObject<HTMLInputElement | null>
  query: string
  loading: boolean
  caseSensitive: boolean
  wholeWord: boolean
  useRegex: boolean
  includePattern: string
  excludePattern: string
  onQueryChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  onKeyDown: (e: React.KeyboardEvent) => void
  onClearSearch: () => void
  onToggleCaseSensitive: () => void
  onToggleWholeWord: () => void
  onToggleRegex: () => void
  onIncludeChange: (value: string) => void
  onExcludeChange: (value: string) => void
}

export function SearchHeader({
  inputRef,
  includeInputRef,
  excludeInputRef,
  query,
  loading,
  caseSensitive,
  wholeWord,
  useRegex,
  includePattern,
  excludePattern,
  onQueryChange,
  onKeyDown,
  onClearSearch,
  onToggleCaseSensitive,
  onToggleWholeWord,
  onToggleRegex,
  onIncludeChange,
  onExcludeChange
}: SearchHeaderProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 p-2 border-b border-border">
      <div className="flex items-center gap-1 bg-input/50 border border-border rounded-sm px-1.5 focus-within:border-ring">
        <SearchIcon size={14} className="text-muted-foreground flex-shrink-0" />
        <input
          ref={inputRef}
          type="text"
          className="flex-1 bg-transparent text-xs py-1.5 outline-none text-foreground placeholder:text-muted-foreground/50 min-w-0"
          placeholder="Search"
          value={query}
          onChange={onQueryChange}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        {loading && (
          <Loader2 size={12} className="text-muted-foreground animate-spin flex-shrink-0" />
        )}
        {query && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="h-auto w-auto rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
            onClick={onClearSearch}
          >
            <X size={12} />
          </Button>
        )}
        <ToggleButton active={caseSensitive} onClick={onToggleCaseSensitive} title="Match Case">
          <CaseSensitive size={14} />
        </ToggleButton>
        <ToggleButton active={wholeWord} onClick={onToggleWholeWord} title="Match Whole Word">
          <WholeWord size={14} />
        </ToggleButton>
        <ToggleButton active={useRegex} onClick={onToggleRegex} title="Use Regular Expression">
          <Regex size={14} />
        </ToggleButton>
      </div>

      {/* Why: the Search tab is a secondary destination — users switch to it
         when they want powerful, scoped search, so include/exclude fields
         stay visible instead of hidden behind a toggle. */}
      <SearchFilters
        includePattern={includePattern}
        excludePattern={excludePattern}
        includeInputRef={includeInputRef}
        excludeInputRef={excludeInputRef}
        onIncludeChange={onIncludeChange}
        onExcludeChange={onExcludeChange}
      />
    </div>
  )
}

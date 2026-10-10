import { Globe, Search, Trash2, X } from 'lucide-react'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'
import { translate } from '@/i18n/i18n'

type BrowserAddressBarSuggestionListProps = {
  suggestions: BrowserAddressBarSuggestion[]
  selectedValue: string
  onSelectedValueChange: (value: string) => void
  onSelect: (url: string) => void
  onRemoveSuggestion?: (url: string) => void
  onClearHistory?: () => void
}

export default function BrowserAddressBarSuggestionList({
  suggestions,
  selectedValue,
  onSelectedValueChange,
  onSelect,
  onRemoveSuggestion,
  onClearHistory
}: BrowserAddressBarSuggestionListProps): React.ReactElement {
  const hasHistorySuggestions = suggestions.some((entry) => entry.lastVisitedAt > 0)

  return (
    <Command shouldFilter={false} value={selectedValue} onValueChange={onSelectedValueChange}>
      <CommandList id="browser-history-listbox" role="listbox">
        <CommandGroup>
          {suggestions.map((entry) => {
            const isRemovable = entry.lastVisitedAt > 0 && !entry.isSearch
            return (
              <CommandItem
                key={entry.url}
                value={entry.url}
                onSelect={() => onSelect(entry.url)}
                className="group flex items-center gap-2 px-3 py-2"
              >
                {entry.isSearch ? (
                  <Search className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Globe className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{entry.title}</span>
                  {entry.subtitle ? (
                    <span className="truncate text-xs text-muted-foreground">{entry.subtitle}</span>
                  ) : null}
                </div>
                {isRemovable && onRemoveSuggestion ? (
                  <button
                    type="button"
                    title={translate(
                      'auto.components.browser.pane.browser.address.bar.suggestions.removeSuggestion',
                      'Remove from history'
                    )}
                    aria-label={translate(
                      'auto.components.browser.pane.browser.address.bar.suggestions.removeSuggestion',
                      'Remove from history'
                    )}
                    className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent-foreground/10 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 group-data-[selected=true]:opacity-100"
                    onPointerDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                    }}
                    onClick={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      onRemoveSuggestion(entry.url)
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                ) : null}
              </CommandItem>
            )
          })}
        </CommandGroup>
        {hasHistorySuggestions && onClearHistory ? (
          <>
            <CommandSeparator />
            <div className="flex items-center justify-between px-3 py-1.5 text-xs text-muted-foreground">
              <span>
                {translate(
                  'auto.components.browser.pane.browser.address.bar.suggestions.history',
                  'History'
                )}
              </span>
              <button
                type="button"
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent-foreground/10 hover:text-foreground"
                onPointerDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onClearHistory()
                }}
              >
                <Trash2 className="size-3" />
                <span>
                  {translate(
                    'auto.components.browser.pane.browser.address.bar.suggestions.clearHistory',
                    'Clear history'
                  )}
                </span>
              </button>
            </div>
          </>
        ) : null}
      </CommandList>
    </Command>
  )
}

import { FileText, Search, Trash2 } from 'lucide-react'
import { BrowserFavicon } from '@/components/browser-favicon'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'
import BrowserHistoryRowRemoveButton from '../history/BrowserHistoryRowRemoveButton'
import { isRemovableHistoryRow } from '../history/browser-history-row-removal'

const NO_SELECTED_ROW = 'orca:no-selected-row'

type BrowserAddressBarSuggestionListProps = {
  suggestions: BrowserAddressBarSuggestion[]
  selectedValue: string
  onSelectedValueChange: (value: string) => void
  onSelect: (url: string) => void
  hasSwitchTarget: (suggestion: BrowserAddressBarSuggestion) => boolean
  /** The row whose button holds keyboard focus (focus itself stays in the input). */
  switchFocusedUrl: string | null
  onSwitchToTab: (url: string) => void
  onRemove: (suggestion: BrowserAddressBarSuggestion) => void
  onClearHistory?: () => void
}

export default function BrowserAddressBarSuggestionList({
  suggestions,
  selectedValue,
  onSelectedValueChange,
  onSelect,
  hasSwitchTarget,
  switchFocusedUrl,
  onSwitchToTab,
  onRemove,
  onClearHistory
}: BrowserAddressBarSuggestionListProps): React.ReactElement {
  const hasHistorySuggestions = suggestions.some((entry) => entry.lastVisitedAt > 0)

  return (
    // cmdk auto-selects its first row for an empty value; use a sentinel when Enter has no target.
    <Command
      shouldFilter={false}
      value={selectedValue || NO_SELECTED_ROW}
      onValueChange={onSelectedValueChange}
    >
      <CommandList id="browser-history-listbox" role="listbox">
        <CommandGroup>
          {suggestions.map((entry) => (
            <CommandItem
              key={entry.url}
              value={entry.url}
              onSelect={() => onSelect(entry.url)}
              className="flex items-center gap-2 px-3 py-2"
            >
              {entry.isSearch ? (
                <Search className="size-3.5 shrink-0 text-muted-foreground" />
              ) : entry.docLocation ? (
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <BrowserFavicon
                  faviconUrl={entry.faviconUrl}
                  className="size-3.5"
                  fallbackClassName="text-muted-foreground"
                />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{entry.title}</span>
                {entry.subtitle ? (
                  <span className="truncate text-xs text-muted-foreground">{entry.subtitle}</span>
                ) : null}
              </div>
              {hasSwitchTarget(entry) ? (
                <Button
                  // Focus stays in the input, so show virtual button focus without relying on :focus-visible.
                  variant={entry.url === switchFocusedUrl ? 'default' : 'outline'}
                  size="xs"
                  tabIndex={-1}
                  className="shrink-0"
                  // Why: keep focus in the address bar so the list stays open through the click.
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation()
                    onSwitchToTab(entry.url)
                  }}
                >
                  {translate(
                    'auto.components.tab.bar.TabBarCreateEntry.8f0a1c4d92',
                    'Switch to tab'
                  )}
                </Button>
              ) : null}
              {isRemovableHistoryRow(entry) ? (
                <BrowserHistoryRowRemoveButton onRemove={() => onRemove(entry)} />
              ) : null}
            </CommandItem>
          ))}
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

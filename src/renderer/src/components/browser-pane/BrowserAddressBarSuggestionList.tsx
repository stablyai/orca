import { Globe, Search } from 'lucide-react'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import type { BrowserAddressBarSuggestion } from './browser-address-bar-suggestions'

type BrowserAddressBarSuggestionListProps = {
  suggestions: BrowserAddressBarSuggestion[]
  selectedValue: string
  onSelectedValueChange: (value: string) => void
  onSelect: (url: string) => void
}

export default function BrowserAddressBarSuggestionList({
  suggestions,
  selectedValue,
  onSelectedValueChange,
  onSelect
}: BrowserAddressBarSuggestionListProps): React.ReactElement {
  return (
    <Command shouldFilter={false} value={selectedValue} onValueChange={onSelectedValueChange}>
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
              ) : (
                <Globe className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{entry.title}</span>
                {entry.subtitle ? (
                  <span className="truncate text-xs text-muted-foreground">{entry.subtitle}</span>
                ) : null}
              </div>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

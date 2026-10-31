import { useMemo, useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
import { getWorkspaceEmojiPickerDefaults } from '@/lib/workspace-emoji-picker-defaults'
import {
  searchWorkspaceEmojiShortcodes,
  type WorkspaceEmojiSuggestion
} from '@/lib/workspace-emoji-shortcodes'

const SEARCH_LIMIT = 50

type WorkspaceEmojiPickerPanelProps = {
  onPick: (emoji: string) => void
}

/** Searchable version of the `:` shortcode suggestion list, so both entry points look the same. */
export function WorkspaceEmojiPickerPanel({
  onPick
}: WorkspaceEmojiPickerPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const items = useMemo<readonly WorkspaceEmojiSuggestion[]>(
    () =>
      query.trim()
        ? searchWorkspaceEmojiShortcodes(query, SEARCH_LIMIT)
        : getWorkspaceEmojiPickerDefaults(),
    [query]
  )

  return (
    <Command
      shouldFilter={false}
      surface="inline"
      density="menu"
      className="w-72"
      onKeyDown={(event) => {
        // Why: cmdk handles Enter as "pick"; it must not also submit the surrounding dialog.
        if (event.key === 'Enter') {
          event.stopPropagation()
        }
      }}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={translate(
          'auto.components.settings.RepositoryIconPicker.searchEmojiPlaceholder',
          'Search emoji'
        )}
      />
      {/* Why: the default 400px list is too tall for a popover anchored to a small text field. */}
      <CommandList style={{ maxHeight: 240 }}>
        <CommandEmpty>{translate('workspace.links.noEmojiFound', 'No emoji found')}</CommandEmpty>
        <CommandGroup
          heading={translate(
            'auto.components.new.workspace.SmartWorkspaceNameField.emoji',
            'Emoji'
          )}
        >
          {items.map((item) => (
            <CommandItem
              key={item.shortcode}
              value={`emoji:${item.shortcode}`}
              onSelect={() => onPick(item.emoji)}
            >
              <span className="w-5 shrink-0 text-center text-sm leading-none">{item.emoji}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-foreground">
                :{item.shortcode}:
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

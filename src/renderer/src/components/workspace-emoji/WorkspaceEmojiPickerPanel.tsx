import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  getWorkspaceEmojiPickerDefaults,
  searchWorkspaceEmojiShortcodes,
  type WorkspaceEmojiSuggestion
} from '@/lib/workspace-emoji-shortcodes'

const COLUMNS = 8
const SEARCH_LIMIT = 64

type WorkspaceEmojiPickerPanelProps = {
  onPick: (emoji: string) => void
}

/** Compact picker built on the shortcode catalog the `:` autocomplete already loads. */
export function WorkspaceEmojiPickerPanel({
  onPick
}: WorkspaceEmojiPickerPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeShortcode, setActiveShortcode] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const items = useMemo<readonly WorkspaceEmojiSuggestion[]>(
    () =>
      query.trim()
        ? searchWorkspaceEmojiShortcodes(query, SEARCH_LIMIT)
        : getWorkspaceEmojiPickerDefaults(),
    [query]
  )
  const footerItem = items.find((item) => item.shortcode === activeShortcode) ?? items[0]

  const focusCell = (index: number): void => {
    gridRef.current?.querySelectorAll<HTMLButtonElement>('button')[index]?.focus()
  }

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter' && items[0]) {
      // Why: Enter must pick here, not bubble up and submit the surrounding dialog.
      event.preventDefault()
      event.stopPropagation()
      onPick(items[0].emoji)
      return
    }
    if (event.key === 'ArrowDown' && items.length > 0) {
      event.preventDefault()
      focusCell(0)
    }
  }

  const handleGridKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const cells = Array.from(gridRef.current?.querySelectorAll('button') ?? [])
    const index = event.target instanceof HTMLButtonElement ? cells.indexOf(event.target) : -1
    if (index === -1) {
      return
    }
    const step =
      event.key === 'ArrowRight'
        ? 1
        : event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowDown'
            ? COLUMNS
            : event.key === 'ArrowUp'
              ? -COLUMNS
              : 0
    if (step === 0) {
      return
    }
    event.preventDefault()
    const next = index + step
    if (next < 0) {
      gridRef.current?.parentElement?.querySelector<HTMLInputElement>('input')?.focus()
      return
    }
    focusCell(Math.min(next, cells.length - 1))
  }

  return (
    <div className="flex w-[272px] flex-col gap-1.5 p-2">
      <Input
        density="compact"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActiveShortcode(null)
        }}
        onKeyDown={handleSearchKeyDown}
        placeholder={translate(
          'auto.components.settings.RepositoryIconPicker.searchEmojiPlaceholder',
          'Search emoji'
        )}
        aria-label={translate(
          'auto.components.settings.RepositoryIconPicker.searchEmojiPlaceholder',
          'Search emoji'
        )}
      />
      {items.length > 0 ? (
        <div
          ref={gridRef}
          role="group"
          onKeyDown={handleGridKeyDown}
          className="grid max-h-[200px] grid-cols-8 overflow-y-auto scrollbar-sleek"
        >
          {items.map((item) => (
            <button
              key={item.shortcode}
              type="button"
              aria-label={`:${item.shortcode}:`}
              onClick={() => onPick(item.emoji)}
              onPointerEnter={() => setActiveShortcode(item.shortcode)}
              onFocus={() => setActiveShortcode(item.shortcode)}
              className="flex size-8 items-center justify-center rounded-sm text-lg leading-none outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {item.emoji}
            </button>
          ))}
        </div>
      ) : (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {translate('workspace.links.noEmojiFound', 'No emoji found')}
        </p>
      )}
      <div className="flex h-7 items-center gap-1.5 border-t border-border px-1 pt-1 text-xs text-muted-foreground">
        {footerItem ? (
          <>
            <span className="text-sm leading-none">{footerItem.emoji}</span>
            <span className="truncate font-mono">:{footerItem.shortcode}:</span>
          </>
        ) : null}
      </div>
    </div>
  )
}

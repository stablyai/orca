import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Copy, Plus } from 'lucide-react'
import { Command, CommandEmpty, CommandInput, CommandList } from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { QuickNote } from '../../../../shared/quick-note-types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { searchQuickNotes } from '@/components/quick-notes/quick-note-search'
import { TabBarQuickNoteItem } from './TabBarQuickNoteItem'

type TabBarQuickNotesMenuProps = {
  notes: readonly QuickNote[]
  mostRecent: QuickNote | null
  onCopyNote: (note: QuickNote) => void
  onAddNote: () => void
  onEditNote: (note: QuickNote) => void
  onDeleteNote: (note: QuickNote) => void
}

export function TabBarQuickNotesMenu({
  notes,
  mostRecent,
  onCopyNote,
  onAddNote,
  onEditNote,
  onDeleteNote
}: TabBarQuickNotesMenuProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false)
  const [query, setQuery] = useState('')
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const showSearch = notes.length > 1

  const filtered = useMemo(() => searchQuickNotes(notes, query), [notes, query])
  const commandValue = filtered[0]?.id ?? ''

  useEffect(() => {
    if (!menuOpen) {
      setQuery('')
    }
  }, [menuOpen])

  useEffect(() => {
    if (!menuOpen || !showSearch) {
      return undefined
    }
    // Why: cmdk needs the input focused so Enter copies the highlighted note.
    const frame = requestAnimationFrame(() => searchInputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [menuOpen, showSearch])

  const copyAndClose = (note: QuickNote): void => {
    setMenuOpen(false)
    onCopyNote(note)
  }

  const moreLabel = translate(
    'auto.components.tab.bar.TabBarQuickNotesMenu.more',
    'More quick notes'
  )
  const splitButtonClass =
    'my-auto flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border border-border/60 text-muted-foreground'
  const innerButtonBase =
    'flex items-center bg-transparent leading-none text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'

  return (
    <div className={splitButtonClass}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => mostRecent && copyAndClose(mostRecent)}
            disabled={!mostRecent}
            className={cn(innerButtonBase, 'gap-1.5 rounded-l-md rounded-r-none px-1.5')}
            aria-label={
              mostRecent
                ? translate(
                    'auto.components.tab.bar.TabBarQuickNotesMenu.copyNamed',
                    'Copy quick note: {{value0}}',
                    { value0: mostRecent.label }
                  )
                : translate('auto.components.tab.bar.TabBarQuickNotesMenu.copy', 'Copy quick note')
            }
          >
            <Copy className="size-3 shrink-0" />
            <span className="max-w-[160px] truncate text-[12px] font-medium">
              {mostRecent?.label ??
                translate('auto.components.tab.bar.TabBarQuickNotesMenu.note', 'Note')}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {mostRecent
            ? translate(
                'auto.components.tab.bar.TabBarQuickNotesMenu.copyTooltip',
                'Copy "{{value0}}" to the clipboard',
                { value0: mostRecent.label }
              )
            : translate('auto.components.tab.bar.TabBarQuickNotesMenu.copy', 'Copy quick note')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={setMenuOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  innerButtonBase,
                  'justify-center rounded-l-none rounded-r-md border-l border-border/60 px-1'
                )}
                aria-label={moreLabel}
              >
                <ChevronDown className="size-3" strokeWidth={2.5} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {moreLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="w-80 p-0">
          <Command shouldFilter={false} loop value={commandValue} className="bg-transparent">
            {showSearch ? (
              <CommandInput
                ref={searchInputRef}
                autoFocus
                placeholder={translate(
                  'auto.components.tab.bar.TabBarQuickNotesMenu.searchPlaceholder',
                  'Search quick notes...'
                )}
                value={query}
                onValueChange={setQuery}
                className="h-9 py-2 text-[12px]"
                wrapperClassName="border-b border-border/50 px-2"
                iconClassName="h-3.5 w-3.5"
              />
            ) : null}
            <CommandList className="max-h-72 py-1">
              {filtered.length === 0 ? (
                <CommandEmpty className="py-4 text-center text-[11px]">
                  {query.trim()
                    ? translate(
                        'auto.components.tab.bar.TabBarQuickNotesMenu.noMatch',
                        'No notes match'
                      )
                    : translate('auto.components.tab.bar.TabBarQuickNotesMenu.empty', 'No notes')}
                </CommandEmpty>
              ) : null}
              {filtered.map((note) => (
                <TabBarQuickNoteItem
                  key={note.id}
                  note={note}
                  onCopy={() => copyAndClose(note)}
                  onEdit={() => {
                    setMenuOpen(false)
                    onEditNote(note)
                  }}
                  onDelete={() => {
                    setMenuOpen(false)
                    onDeleteNote(note)
                  }}
                />
              ))}
            </CommandList>
            <div className="border-t border-border/50 p-1">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false)
                  onAddNote()
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <Plus className="size-3.5" />
                {translate('auto.components.tab.bar.TabBarQuickNotesMenu.add', 'Note')}
              </button>
            </div>
          </Command>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

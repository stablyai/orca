import type { MouseEvent, PointerEvent } from 'react'
import { Pencil, StickyNote, Trash2 } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import type { QuickNote } from '../../../../shared/quick-note-types'
import { translate } from '@/i18n/i18n'

type TabBarQuickNoteItemProps = {
  note: QuickNote
  onCopy: () => void
  onEdit: () => void
  onDelete: () => void
}

function stopRowSelect(event: MouseEvent | PointerEvent): void {
  // Why: cmdk selects the parent CommandItem on click; nested actions must not
  // also copy the note.
  event.preventDefault()
  event.stopPropagation()
}

/** First non-empty line of the note body, for the row preview. */
function bodyPreview(body: string): string {
  return (
    body
      .split(/\r\n|\r|\n/)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  )
}

export function TabBarQuickNoteItem({
  note,
  onCopy,
  onEdit,
  onDelete
}: TabBarQuickNoteItemProps): React.JSX.Element {
  return (
    <CommandItem
      value={note.id}
      keywords={[note.label, note.body]}
      onSelect={onCopy}
      className="group/qn mx-1 my-0.5 cursor-pointer items-center gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground"
    >
      <StickyNote className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{note.label}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {bodyPreview(note.body)}
        </span>
      </span>
      <span
        role="group"
        aria-label={translate(
          'auto.components.tab.bar.TabBarQuickNoteItem.actions',
          'Quick note actions'
        )}
        className="flex shrink-0 items-center gap-0.5 can-hover:opacity-0 transition-opacity group-hover/qn:opacity-100 group-data-[selected=true]/qn:opacity-100"
      >
        <button
          type="button"
          onPointerDown={stopRowSelect}
          onClick={(event) => {
            stopRowSelect(event)
            onEdit()
          }}
          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={translate(
            'auto.components.tab.bar.TabBarQuickNoteItem.edit',
            'Edit {{value0}}',
            { value0: note.label }
          )}
        >
          <Pencil className="size-3" />
        </button>
        <button
          type="button"
          onPointerDown={stopRowSelect}
          onClick={(event) => {
            stopRowSelect(event)
            onDelete()
          }}
          className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
          aria-label={translate(
            'auto.components.tab.bar.TabBarQuickNoteItem.remove',
            'Remove {{value0}}',
            { value0: note.label }
          )}
        >
          <Trash2 className="size-3" />
        </button>
      </span>
    </CommandItem>
  )
}

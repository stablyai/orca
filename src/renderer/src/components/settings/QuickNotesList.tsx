import { Check, Copy, Pencil, StickyNote, Trash2 } from 'lucide-react'
import type { QuickNote } from '../../../../shared/quick-note-types'
import { useClipboardTextCopyFeedback } from '@/hooks/use-clipboard-text-copy-feedback'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

function QuickNoteRow({
  note,
  onEdit,
  onRemove
}: {
  note: QuickNote
  onEdit: (note: QuickNote) => void
  onRemove: (note: QuickNote) => void
}): React.JSX.Element {
  const { canCopy, copyText, status } = useClipboardTextCopyFeedback(note.body)
  const name =
    note.label || translate('auto.components.settings.QuickNotesList.untitled', 'Untitled')

  const copyLabel =
    status === 'copied'
      ? translate('auto.components.settings.QuickNotesList.copied', 'Copied')
      : status === 'failed'
        ? translate('auto.components.settings.QuickNotesList.copyFailed', "Couldn't copy")
        : translate('auto.components.settings.QuickNotesList.copy', 'Copy {{value0}}', {
            value0: name
          })
  const editLabel = translate('auto.components.settings.QuickNotesList.edit', 'Edit {{value0}}', {
    value0: name
  })

  return (
    <div className="group/qn flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/60 focus-within:bg-accent/60">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{name}</div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
          {note.body
            .split(/\r\n|\r|\n/)
            .find((line) => line.trim().length > 0)
            ?.trim() || translate('auto.components.settings.QuickNotesList.noText', 'No text')}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 transition-opacity can-hover:opacity-0 group-hover/qn:opacity-100 group-focus-within/qn:opacity-100">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={editLabel}
          title={editLabel}
          onClick={() => onEdit(note)}
        >
          <Pencil />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={!canCopy}
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => void copyText()}
          className={cn(
            status === 'copied' && 'text-status-success',
            status === 'failed' && 'text-destructive'
          )}
        >
          {status === 'copied' ? <Check /> : <Copy />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={translate(
            'auto.components.settings.QuickNotesList.remove',
            'Remove {{value0}}',
            {
              value0: name
            }
          )}
          onClick={() => onRemove(note)}
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

export function QuickNotesList({
  notes,
  visibleNotes,
  hasQuery,
  onEdit,
  onRemove
}: {
  notes: QuickNote[]
  visibleNotes: QuickNote[]
  hasQuery: boolean
  onEdit: (note: QuickNote) => void
  onRemove: (note: QuickNote) => void
}): React.JSX.Element {
  if (visibleNotes.length === 0) {
    if (notes.length > 0) {
      return (
        <div className="px-2 py-10 text-center text-sm text-muted-foreground">
          {hasQuery
            ? translate(
                'auto.components.settings.QuickNotesList.noSearchMatches',
                'No notes match this search.'
              )
            : translate('auto.components.settings.QuickNotesList.none', 'No notes saved.')}
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center gap-3 px-2 py-10 text-center">
        <StickyNote className="size-7 text-muted-foreground/50" />
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            {translate('auto.components.settings.QuickNotesList.none', 'No notes saved.')}
          </p>
          <p className="text-xs text-muted-foreground/80">
            {translate(
              'auto.components.settings.QuickNotesList.hint',
              'Pick one from the Note button in the tab bar to copy it to the clipboard.'
            )}
          </p>
        </div>
      </div>
    )
  }
  return (
    <div className="-mx-2 divide-y divide-border/50">
      {visibleNotes.map((note) => (
        <QuickNoteRow key={note.id} note={note} onEdit={onEdit} onRemove={onRemove} />
      ))}
    </div>
  )
}

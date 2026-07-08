import React from 'react'
import { Maximize2 } from 'lucide-react'
import type { TodoNote, WorktreeTodoAuthorRole } from '../../../../../shared/types'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { TodoNotesDoc } from './TodoNotesDoc'
import { TodoNotesSection } from './TodoNotesSection'

type TodoNotesPanelProps = {
  notesDoc?: string
  notesDocAuthorRole?: WorktreeTodoAuthorRole
  notesDocUpdatedAt?: number
  notes: TodoNote[]
  /** Open straight into the page editor when the todo has no content yet. */
  autoFocusDoc: boolean
  onSetNotesDoc: (body: string) => Promise<boolean>
  onAddNote: (body: string) => Promise<TodoNote | null>
  onUpdateNote: (noteId: string, body: string) => Promise<boolean>
  onDeleteNote: (noteId: string) => Promise<void>
  onOpenFullPage: () => void
}

// Why: the expanded section is a "page + updates" hybrid — a rich markdown page
// (durable context) on top, then a divider and the stamped updates timeline
// below. Indented + hairline rule reads as a child of the row, Airtable-style.
export function TodoNotesPanel({
  notesDoc,
  notesDocAuthorRole,
  notesDocUpdatedAt,
  notes,
  autoFocusDoc,
  onSetNotesDoc,
  onAddNote,
  onUpdateNote,
  onDeleteNote,
  onOpenFullPage
}: TodoNotesPanelProps): React.JSX.Element {
  return (
    <div className="ml-7 mr-2 mb-1 flex flex-col gap-2 border-l border-border/60 pl-2 pt-1">
      <div className="flex items-center justify-end">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          data-testid="todo-panel-open-page"
          onClick={onOpenFullPage}
          className="text-muted-foreground hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.todos.TodoRow.openPage',
            'Open full page'
          )}
          title={translate(
            'auto.components.right.sidebar.todos.TodoRow.openPage',
            'Open full page'
          )}
        >
          <Maximize2 className="size-3" />
        </Button>
      </div>
      <TodoNotesDoc
        value={notesDoc ?? ''}
        authorRole={notesDocAuthorRole}
        updatedAt={notesDocUpdatedAt}
        autoFocus={autoFocusDoc}
        onSave={onSetNotesDoc}
      />
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/55">
            {translate('auto.components.right.sidebar.todos.TodoNotesPanel.updates', 'Updates')}
          </span>
          <div className="h-px flex-1 bg-border/50" />
        </div>
        <TodoNotesSection
          notes={notes}
          onAddNote={onAddNote}
          onUpdateNote={onUpdateNote}
          onDeleteNote={onDeleteNote}
        />
      </div>
    </div>
  )
}

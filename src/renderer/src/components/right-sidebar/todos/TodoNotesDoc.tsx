import React, { useState } from 'react'
import type { WorktreeTodoAuthorRole } from '../../../../../shared/types'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'
import { formatPrCommentRelativeTime } from '@/lib/pr-comment-time'
import { TodoNotesDocEditor } from './TodoNotesDocEditor'

type TodoNotesDocProps = {
  value: string
  authorRole?: WorktreeTodoAuthorRole
  updatedAt?: number
  autoFocus: boolean
  onSave: (body: string) => Promise<boolean>
}

const PLACEHOLDER_KEY = 'auto.components.right.sidebar.todos.TodoNotesDoc.placeholder'
const PLACEHOLDER_FALLBACK = 'Add details — markdown supported (headings, lists, links)…'

export function TodoNotesDoc({
  value,
  authorRole,
  updatedAt,
  autoFocus,
  onSave
}: TodoNotesDocProps): React.JSX.Element {
  const [editing, setEditing] = useState(autoFocus && value.length === 0)

  if (editing) {
    return (
      <TodoNotesDocEditor
        value={value}
        autoFocus
        onSave={onSave}
        onDone={() => setEditing(false)}
        placeholder={translate(PLACEHOLDER_KEY, PLACEHOLDER_FALLBACK)}
      />
    )
  }

  if (value.length === 0) {
    return (
      <button
        type="button"
        data-testid="todo-notes-doc-empty"
        onClick={() => setEditing(true)}
        className="w-full rounded-sm px-2 py-1.5 text-left text-[12px] text-muted-foreground/50 hover:bg-accent/30 hover:text-muted-foreground"
      >
        {translate('auto.components.right.sidebar.todos.TodoNotesDoc.addPage', 'Add details…')}
      </button>
    )
  }

  const authorLabel =
    authorRole === 'agent'
      ? translate('auto.components.right.sidebar.todos.TodoNotesDoc.authorAgent', 'agent')
      : translate('auto.components.right.sidebar.todos.TodoNotesDoc.authorUser', 'user')

  return (
    <div className="flex flex-col gap-0.5">
      <button
        type="button"
        data-testid="todo-notes-doc-preview"
        onClick={() => setEditing(true)}
        // Why: click-to-edit mirrors the inline body/note edit pattern; links
        // inside the preview stopPropagation so they open instead of editing.
        className="w-full cursor-text rounded-sm px-2 py-1 text-left hover:bg-accent/20"
      >
        <CommentMarkdown
          variant="document"
          content={value}
          className="text-[12px] leading-relaxed text-foreground/90"
        />
      </button>
      {updatedAt !== undefined && (
        <span className="px-2 text-[10px] text-muted-foreground/60">
          {translate(
            'auto.components.right.sidebar.todos.TodoNotesDoc.lastEdited',
            'edited by {{author}} · {{time}}',
            {
              author: authorLabel,
              time: formatPrCommentRelativeTime(new Date(updatedAt).toISOString(), Date.now())
            }
          )}
        </span>
      )}
    </div>
  )
}

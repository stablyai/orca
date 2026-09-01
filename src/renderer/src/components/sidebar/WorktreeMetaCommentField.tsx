import React, { useCallback } from 'react'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'

function resizeCommentTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto'
  textarea.style.height = `${textarea.scrollHeight}px`
}

/** Comment field for the worktree meta dialog. Extracted so the dialog stays
 *  under the max-lines limit. */
export function WorktreeMetaCommentField({
  textareaRef,
  value,
  onValueChange,
  onSubmit,
  active
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  active: boolean
}): React.JSX.Element {
  const submitShortcutLabel = getScreenSubmitShortcutLabel()

  const setTextareaRef = useCallback(
    (textarea: HTMLTextAreaElement | null) => {
      textareaRef.current = textarea
      if (textarea && active) {
        resizeCommentTextarea(textarea)
      }
    },
    [active, textareaRef]
  )

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      onValueChange(event.target.value)
      // Why: notes should grow in the same input event; a passive Effect leaves a stale height.
      resizeCommentTextarea(event.currentTarget)
    },
    [onValueChange]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isPlainEnter = e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey
      if (isPlainEnter || isScreenSubmitShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
        onSubmit()
      }
    },
    [onSubmit]
  )

  return (
    <div className="space-y-1">
      <label className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.sidebar.WorktreeMetaDialog.9c1d1e9b71', 'Comment')}
      </label>
      <textarea
        ref={setTextareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={translate(
          'auto.components.sidebar.WorktreeMetaDialog.030d484fc0',
          'Notes about this worktree...'
        )}
        rows={3}
        className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 resize-none max-h-60 overflow-y-auto scrollbar-sleek"
      />
      <p className="text-[10px] text-muted-foreground">
        {translate(
          'auto.components.sidebar.WorktreeMetaDialog.7f0be5e9a6',
          'Supports **markdown** — bold, lists, `code`, links. Press Enter or'
        )}{' '}
        {submitShortcutLabel}{' '}
        {translate(
          'auto.components.sidebar.WorktreeMetaDialog.b48c271d39',
          'to save, Shift+Enter for a new line.'
        )}
      </p>
    </div>
  )
}

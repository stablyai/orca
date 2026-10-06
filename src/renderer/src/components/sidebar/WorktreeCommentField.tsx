import { useId } from 'react'
import { ImeTextarea } from '@/lib/ime-text-field'
import { getScreenSubmitShortcutLabel } from '@/lib/screen-submit-shortcut'
import { translate } from '@/i18n/i18n'

type WorktreeCommentFieldProps = {
  textareaRef: (element: HTMLTextAreaElement | null) => void
  value: string
  onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

/** Labelled markdown comment textarea for the worktree meta dialog. */
export function WorktreeCommentField({
  textareaRef,
  value,
  onChange,
  onKeyDown
}: WorktreeCommentFieldProps): React.JSX.Element {
  const textareaId = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={textareaId} className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.sidebar.WorktreeMetaDialog.9c1d1e9b71', 'Comment')}
      </label>
      <ImeTextarea
        id={textareaId}
        ref={textareaRef}
        value={value}
        onChange={onChange}
        onKeyDown={onKeyDown}
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
        {getScreenSubmitShortcutLabel()}{' '}
        {translate(
          'auto.components.sidebar.WorktreeMetaDialog.b48c271d39',
          'to save, Shift+Enter for a new line.'
        )}
      </p>
    </div>
  )
}

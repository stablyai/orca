import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Pencil, X } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { ButtonKeyHint } from '@/components/ButtonKeyHint'
import { isMacPlatform } from './native-chat-shortcut'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'

/** The inline editor that replaces a queued card's row while it is edited. It lives in the card,
 *  not the composer, so it stays usable while a question or approval holds the composer's slot. */
export function NativeChatQueuedMessageEditor({
  editor,
  sender
}: {
  editor: QueuedMessageInlineEditor
  /** The card's "From <name>" line, kept beside the label. */
  sender?: ReactNode
}): React.JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    if (editor.acquiring) {
      return
    }
    const textarea = field.current
    textarea?.focus({ preventScroll: true })
    const list = textarea?.closest('ul')
    const row = textarea?.closest('li')
    if (list && row) {
      const rowBounds = row.getBoundingClientRect()
      const listBounds = list.getBoundingClientRect()
      if (rowBounds.top < listBounds.top) {
        list.scrollTop += rowBounds.top - listBounds.top
      } else if (rowBounds.bottom > listBounds.bottom) {
        list.scrollTop += rowBounds.bottom - listBounds.bottom
      }
    }
  }, [editor.acquiring])
  return (
    <div data-queued-message-editor>
      <div className="flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground">
        <Pencil className="size-3.5 shrink-0" aria-hidden />
        <span className="shrink-0">
          {translate('components.native-chat.queuedMessages.editingMessage', 'Editing message')}
        </span>
        {sender ? (
          <>
            <span aria-hidden>·</span>
            <div className="min-w-0">{sender}</div>
          </>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="ml-auto"
          aria-label={translate(
            'components.native-chat.queuedMessages.cancelEditing',
            'Cancel editing'
          )}
          onClick={editor.cancel}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <Textarea
        ref={field}
        aria-label={translate('components.native-chat.queuedMessages.editMessage', 'Edit message')}
        className="max-h-32 resize-none"
        rows={2}
        value={editor.text}
        readOnly={editor.acquiring || editor.saving}
        onChange={(event) => editor.change(event.currentTarget.value)}
        // Enter or Cmd/Ctrl+Enter saves, Shift+Enter is a newline, Escape cancels; an IME's own
        // Enter and Escape never get here (`ImeTextarea`). Handled keys stay out of the prompt.
        onKeyDown={(event) => {
          const mod = isMacPlatform() ? event.metaKey : event.ctrlKey
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            editor.cancel()
          } else if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.altKey &&
            (mod || (!event.metaKey && !event.ctrlKey))
          ) {
            event.preventDefault()
            event.stopPropagation()
            if (editor.canSave && !editor.acquiring && !editor.saving) {
              editor.save()
            }
          }
        }}
      />
      <div className="mt-1.5 flex justify-end">
        <Button
          type="button"
          size="xs"
          disabled={editor.acquiring || editor.saving || !editor.canSave}
          onClick={editor.save}
        >
          {translate('components.native-chat.queuedMessages.save', 'Save')}
          <ButtonKeyHint />
        </Button>
      </div>
    </div>
  )
}

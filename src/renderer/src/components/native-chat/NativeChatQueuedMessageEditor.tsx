import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Pencil, Plus, X } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ButtonKeyHint } from '@/components/ButtonKeyHint'
import { isMacPlatform } from './native-chat-shortcut'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import { NativeChatPaneFileDropOverlay } from './NativeChatPaneFileDropSurface'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'
import {
  useNativeChatQueuedEditImageIntake,
  type QueuedEditAttachTarget
} from './use-native-chat-queued-edit-image-intake'

/** Edit inside the card so questions and approvals occupying the composer do not block queued-draft editing. */
export function NativeChatQueuedMessageEditor({
  editor,
  sender,
  images,
  attachTo
}: {
  editor: QueuedMessageInlineEditor
  /** The card's "From <name>" line, kept beside the label. */
  sender?: ReactNode
  /** The card's image count, shown where the host edits text only and so keeps the images. */
  images?: ReactNode
  /** The chat this card's added files attach to, as its chat box attaches them. */
  attachTo?: QueuedEditAttachTarget
}): React.JSX.Element {
  const field = useRef<HTMLTextAreaElement>(null)
  const intake = useNativeChatQueuedEditImageIntake(editor, attachTo, field)
  const chips = editor.images?.chips ?? []
  const empty = editor.images?.empty === true
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
    <div
      data-queued-message-editor
      className="relative px-2.5 py-1.5"
      onPasteCapture={intake.onPasteCapture}
    >
      {intake.isDragActive ? <NativeChatPaneFileDropOverlay queuedMessage /> : null}
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
        <div className="ml-auto flex items-center">{editor.images ? null : images}</div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={translate(
            'components.native-chat.queuedMessages.cancelEditing',
            'Cancel editing'
          )}
          onClick={editor.cancel}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {chips.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-2 px-1 pt-1.5">
          {chips.map((chip) => (
            <NativeChatImageAttachmentPreview
              key={chip.id}
              attachment={chip}
              hostEnvironmentId={intake.hostEnvironmentId}
              onRemove={(id) => editor.images?.intake.remove(id)}
            />
          ))}
        </div>
      ) : null}
      <Textarea
        ref={field}
        aria-label={translate('components.native-chat.queuedMessages.editMessage', 'Edit message')}
        className="max-h-32 resize-none"
        rows={2}
        value={editor.text}
        readOnly={editor.acquiring || editor.saving}
        onChange={(event) => editor.change(event.currentTarget.value)}
        // Handle save/cancel keys outside the prompt; ImeTextarea keeps IME Enter/Escape out of this handler.
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
      <div className="mt-1.5 flex items-center gap-1.5">
        {intake.editable ? <QueuedEditAttachButton onAttach={intake.attach} /> : null}
        {intake.editable ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {empty
              ? translate(
                  'components.native-chat.queuedMessages.saveNeedsContent',
                  'Add text or an image to save'
                )
              : translate(
                  'components.native-chat.queuedMessages.pasteOrDropImages',
                  'Paste or drop images'
                )}
          </span>
        ) : null}
        <div className="ml-auto">
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
    </div>
  )
}

function QueuedEditAttachButton({ onAttach }: { onAttach: () => void }): React.JSX.Element {
  const label = translate('components.native-chat.composer.attach', 'Attach file')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={onAttach}>
          <Plus className="size-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

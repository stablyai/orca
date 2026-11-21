import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { isMacPlatform } from '@/components/native-chat/pane/routing/native-chat-shortcut'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { formatNativeChatNoteTime, type NativeChatMediaNote } from './native-chat-media-notes'
import type { NativeChatNotesEditor } from './use-native-chat-notes-editor'

/** The notes list and its editor, in the white card the viewer floats at the right (a bottom sheet when narrow). */
export function NativeChatMediaNotesPanel({
  editor,
  preciseTimes,
  narrow,
  onHide,
  onConfirmed,
  onEditorClosed,
  sendSlot
}: {
  editor: NativeChatNotesEditor
  /** Notes on two frames in the same second show tenths. */
  preciseTimes: boolean
  narrow: boolean
  onHide: () => void
  /** The prompt was answered with Add/Save or Discard; the viewer finishes what asked for it. */
  onConfirmed: (reason: 'close' | 'done' | 'replace' | 'cancel') => void
  /** Focus goes back to the media once the editor closes. */
  onEditorClosed: () => void
  /** The Send button, shown at the bottom of the sheet when narrow. */
  sendSlot?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const { notes, pending, editing, confirm, status } = editor
  const timeOf = (note: NativeChatMediaNote): string | null =>
    note.time === undefined
      ? null
      : t('components.native-chat.notes.atTime', 'at {{time}}', {
          time: formatNativeChatNoteTime(note.time, preciseTimes)
        })
  return (
    <section
      aria-label={t('components.native-chat.notes.title', 'Notes')}
      className={cn(
        // A white card on dark media in both themes, as the media viewer always is.
        'flex flex-col bg-popover text-popover-foreground shadow-[0_10px_30px_rgb(0_0_0/0.45)]',
        narrow ? 'max-h-[52%] rounded-t-xl' : 'max-h-[calc(100%-7rem)] w-80 rounded-xl'
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border py-2 pr-2 pl-3.5">
        <h2 className="text-sm font-semibold">
          {t('components.native-chat.notes.title', 'Notes')}
        </h2>
        <span className="text-sm text-muted-foreground">{notes.length}</span>
        <span className="flex-1" />
        {notes.length > 1 ? (
          <button
            type="button"
            onClick={editor.clear}
            className="rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            {t('components.native-chat.notes.clear', 'Clear')}
          </button>
        ) : null}
        <ShortcutKeyCombo size="compact" keys={isMacPlatform() ? ['⇧', 'C'] : ['Shift', 'C']} />
        <button
          type="button"
          aria-label={t('components.native-chat.notes.hide', 'Hide notes')}
          title={t('components.native-chat.notes.hide', 'Hide notes')}
          onClick={onHide}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X className="size-3.5" />
        </button>
      </header>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {notes.length === 0 && !pending ? (
          <p className="px-1.5 py-1 text-sm leading-relaxed text-muted-foreground">
            {t('components.native-chat.notes.emptyPin', 'Click to pin a spot')}
            <br />
            {t('components.native-chat.notes.emptyBox', 'Drag to box an area')}
          </p>
        ) : null}
        {notes.map((note) =>
          editing?.id === note.id ? (
            <NoteEditor
              key={note.id}
              editor={editor}
              note={note}
              time={timeOf(note)}
              onClosed={onEditorClosed}
            />
          ) : (
            <NoteRow key={note.id} note={note} time={timeOf(note)} editor={editor} />
          )
        )}
        {pending ? (
          <NoteEditor
            editor={editor}
            note={pending}
            time={timeOf(pending)}
            onClosed={onEditorClosed}
          />
        ) : null}
        {confirm ? <ConfirmPrompt editor={editor} onConfirmed={onConfirmed} /> : null}
      </div>
      {status ? (
        <div
          role="status"
          className={cn(
            'flex shrink-0 items-center gap-2 border-t border-border px-3.5 py-1.5 text-xs',
            status.kind === 'error' || status.kind === 'frame-limit' ? 'text-destructive' : ''
          )}
        >
          <span className="flex-1">
            {status.kind === 'removed'
              ? t('components.native-chat.notes.removed', '{{count}} removed', {
                  count: status.count
                })
              : status.kind === 'frame-limit'
                ? t(
                    'components.native-chat.notes.frameLimit',
                    'Up to 8 video frames per message. Send these notes first, or add this note at a time that already has notes.'
                  )
                : status.message}
          </span>
          {status.kind === 'removed' ? (
            <button
              type="button"
              onClick={editor.undo}
              className="font-semibold text-foreground underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {t('components.native-chat.notes.undo', 'Undo')}
            </button>
          ) : null}
        </div>
      ) : null}
      {notes.length > 0 || pending ? (
        <p
          className={cn(
            'shrink-0 border-t border-border px-3.5 py-2 text-xs text-muted-foreground',
            narrow && 'hidden'
          )}
        >
          {t('components.native-chat.notes.hint', 'Click to pin, drag to box')}
        </p>
      ) : null}
      {narrow && sendSlot ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-2.5 py-2">
          {sendSlot}
        </div>
      ) : null}
    </section>
  )
}

function NoteRow({
  note,
  time,
  editor
}: {
  note: NativeChatMediaNote
  time: string | null
  editor: NativeChatNotesEditor
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="group/note flex items-start gap-2 rounded-md p-1.5 hover:bg-accent focus-within:bg-accent">
      <NoteNumber number={note.number} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => editor.open(note.id)}
          aria-label={t('components.native-chat.notes.editNote', 'Edit note {{number}}: {{text}}', {
            number: note.number,
            text: note.text
          })}
          className="block w-full rounded text-left text-sm whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-ring"
        >
          {note.text}
        </button>
        {time ? <div className="text-xs text-muted-foreground">{time}</div> : null}
      </div>
      <button
        type="button"
        onClick={() => editor.remove(note.id)}
        aria-label={t('components.native-chat.notes.removeNote', 'Remove note {{number}}', {
          number: note.number
        })}
        className="rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 group-hover/note:opacity-100 group-focus-within/note:opacity-100 hover:bg-accent focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
      >
        {t('components.native-chat.notes.remove', 'Remove')}
      </button>
    </div>
  )
}

function NoteNumber({ number }: { number: number }): React.JSX.Element {
  return (
    <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-media-note text-2xs font-semibold text-media-note-foreground">
      {number}
    </span>
  )
}

function NoteEditor({
  editor,
  note,
  time,
  onClosed
}: {
  editor: NativeChatNotesEditor
  note: NativeChatMediaNote
  time: string | null
  onClosed: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const adding = editor.pending?.id === note.id
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const field = ref.current
    if (field) {
      field.focus({ preventScroll: true })
      field.setSelectionRange(field.value.length, field.value.length)
      field.closest('[data-note-editor]')?.scrollIntoView({ block: 'nearest' })
    }
  }, [note.id])
  const canCommit = adding ? editor.draftText.trim() !== '' : editor.hasUnadded
  const close = (): void => {
    if (editor.hasUnadded) {
      editor.setConfirm({ reason: 'cancel' })
    } else {
      editor.closeEditor()
      onClosed()
    }
  }
  const heading = adding
    ? t('components.native-chat.notes.newNote', 'New note')
    : t('components.native-chat.notes.noteNumber', 'Note {{number}}', { number: note.number })
  return (
    <div
      data-note-editor=""
      className="my-1.5 rounded-lg border border-border bg-background p-2 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        <NoteNumber number={note.number} />
        <span>{time ? `${heading} ${time}` : heading}</span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={close}
          aria-label={
            adding
              ? t('components.native-chat.notes.discardNew', 'Discard note {{number}}', {
                  number: note.number
                })
              : t('components.native-chat.notes.closeEditor', 'Close editor')
          }
          className="flex size-6 items-center justify-center rounded hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
        >
          <X className="size-3" />
        </button>
      </div>
      <textarea
        ref={ref}
        rows={2}
        value={editor.draftText}
        aria-label={heading}
        placeholder={t('components.native-chat.notes.placeholder', 'Add a note')}
        onChange={(event) => editor.setDraftText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) {
            return
          }
          if (event.key === 'Enter' && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
            event.preventDefault()
            if (canCommit && editor.commit()) {
              onClosed()
            }
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close()
          }
        }}
        className="w-full resize-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="flex justify-end">
        <Button
          type="button"
          size="xs"
          disabled={!canCommit}
          onClick={() => editor.commit() && onClosed()}
        >
          {adding
            ? t('components.native-chat.notes.add', 'Add')
            : t('components.native-chat.notes.save', 'Save')}
          <ShortcutKeyCombo size="compact" keys={['↵']} onFill />
        </Button>
      </div>
    </div>
  )
}

function ConfirmPrompt({
  editor,
  onConfirmed
}: {
  editor: NativeChatNotesEditor
  onConfirmed: (reason: 'close' | 'done' | 'replace' | 'cancel') => void
}): React.JSX.Element {
  const t = useTranslate()
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => keep.current?.focus(), [])
  const reason = editor.confirm!.reason
  const number = editor.pending?.number ?? editor.editing?.number ?? 0
  const message = editor.pending
    ? t('components.native-chat.notes.notAdded', 'Note {{number}} isn’t added yet.', { number })
    : t('components.native-chat.notes.notSaved', 'Your change to note {{number}} isn’t saved.', {
        number
      })
  return (
    <div
      role="alertdialog"
      aria-label={message}
      className="my-1.5 rounded-lg border border-status-warning-border bg-status-warning-background p-2 text-xs text-status-warning-foreground"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          editor.setConfirm(null)
        }
      }}
    >
      {message}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        <Button
          ref={keep}
          type="button"
          size="xs"
          onClick={() => editor.commit() && onConfirmed(reason)}
        >
          {editor.pending
            ? t('components.native-chat.notes.addNote', 'Add note')
            : t('components.native-chat.notes.save', 'Save')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => {
            editor.closeEditor()
            onConfirmed(reason)
          }}
        >
          {t('components.native-chat.notes.discard', 'Discard')}
        </Button>
        <Button type="button" size="xs" variant="outline" onClick={() => editor.setConfirm(null)}>
          {t('components.native-chat.notes.keepEditing', 'Keep editing')}
        </Button>
      </div>
    </div>
  )
}

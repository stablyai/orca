import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { Button } from '@/components/ui/button'
import { isImeCompositionKeyDown } from '@/lib/text-input/ime/ime-composition-keyboard-event'

/** The panel's error line, focused when a hand-off fails. */
export const NATIVE_CHAT_NOTES_ERROR_ID = 'native-chat-notes-error'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { isMacPlatform } from '@/components/native-chat/pane/routing/native-chat-shortcut'
import { useTranslate } from '@/i18n/use-translate'
import {
  formatNativeChatNoteTime,
  NATIVE_CHAT_NOTE_TEXT_MAX,
  type NativeChatMediaNote
} from './native-chat-media-notes'
import type { NativeChatNotesEditor } from './use-native-chat-notes-editor'

/** The note editor shows its length from here on. */
const NOTE_TEXT_WARN = NATIVE_CHAT_NOTE_TEXT_MAX - 200

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
        'flex flex-col bg-media-paper text-media-paper-foreground shadow-xl',
        // The sheet shrinks within its capped holder, so a long list scrolls above Send.
        narrow ? 'min-h-0 rounded-t-xl' : 'max-h-[calc(100%-7rem)] w-80 rounded-xl'
      )}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b border-media-paper-border py-2 pr-2 pl-3.5">
        <h2 className="text-sm font-semibold">
          {t('components.native-chat.notes.title', 'Notes')}
        </h2>
        <span className="text-sm text-media-paper-muted">{notes.length}</span>
        <span className="flex-1" />
        {notes.length > 1 ? (
          <Button type="button" variant="media-paper-ghost" size="xs" onClick={editor.clear}>
            {t('components.native-chat.notes.clear', 'Clear')}
          </Button>
        ) : null}
        <Button
          type="button"
          aria-label={t('components.native-chat.notes.hide', 'Hide notes')}
          aria-keyshortcuts="Shift+C"
          // The shortcut belongs to Hide, so it is named here and not beside Clear.
          title={`${t('components.native-chat.notes.hide', 'Hide notes')} (${isMacPlatform() ? '⇧C' : 'Shift+C'})`}
          onClick={onHide}
          variant="media-paper-ghost"
          size="icon-xs"
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {notes.length === 0 && !pending ? (
          <p className="px-1.5 py-1 text-sm leading-relaxed text-media-paper-muted">
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
          // An error takes focus when it appears (a failed hand-off), so it is heard and seen.
          role={status.kind === 'error' ? 'alert' : 'status'}
          id={status.kind === 'error' ? NATIVE_CHAT_NOTES_ERROR_ID : undefined}
          tabIndex={status.kind === 'error' ? -1 : undefined}
          className={cn(
            'flex shrink-0 items-center gap-2 border-t border-media-paper-border px-3.5 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-media-note',
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
            <Button type="button" variant="media-paper-ghost" size="xs" onClick={editor.undo}>
              {t('components.native-chat.notes.undo', 'Undo')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {notes.length > 0 || pending ? (
        <p
          className={cn(
            'shrink-0 border-t border-media-paper-border px-3.5 py-2 text-xs text-media-paper-muted',
            narrow && 'hidden'
          )}
        >
          {t('components.native-chat.notes.hint', 'Click to pin, drag to box')}
        </p>
      ) : null}
      {narrow && sendSlot ? (
        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-media-paper-border px-2.5 py-2">
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
    <div className="group/note relative flex items-start gap-2 rounded-md p-1.5 hover:bg-media-paper-hover focus-within:bg-media-paper-hover">
      <NoteNumber number={note.number} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={() => editor.open(note.id)}
          aria-label={t('components.native-chat.notes.editNote', 'Edit note {{number}}: {{text}}', {
            number: note.number,
            text: note.text
          })}
          className="block w-full rounded text-left text-sm whitespace-pre-wrap break-words focus-visible:outline-2 focus-visible:outline-media-note"
        >
          {note.text}
        </button>
        {time ? <div className="text-xs text-media-paper-muted">{time}</div> : null}
      </div>
      {/* Laid over the row's end, so the note text keeps the full width until it is needed. */}
      <span className="absolute top-1 right-1 opacity-0 group-hover/note:opacity-100 group-focus-within/note:opacity-100">
        <Button
          type="button"
          variant="media-paper"
          size="xs"
          onClick={() => editor.remove(note.id)}
          aria-label={t('components.native-chat.notes.removeNote', 'Remove note {{number}}', {
            number: note.number
          })}
        >
          {t('components.native-chat.notes.remove', 'Remove')}
        </Button>
      </span>
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
      className="my-1.5 rounded-lg border border-media-paper-border bg-media-paper p-2 focus-within:border-media-note focus-within:ring-1 focus-within:ring-media-note"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs text-media-paper-muted">
        <NoteNumber number={note.number} />
        <span>{time ? `${heading} ${time}` : heading}</span>
        <span className="flex-1" />
        <Button
          type="button"
          onClick={close}
          aria-label={
            adding
              ? t('components.native-chat.notes.discardNew', 'Discard note {{number}}', {
                  number: note.number
                })
              : t('components.native-chat.notes.closeEditor', 'Close editor')
          }
          variant="media-paper-ghost"
          size="icon-xs"
        >
          <X className="size-3" />
        </Button>
      </div>
      <textarea
        ref={ref}
        rows={2}
        value={editor.draftText}
        aria-label={heading}
        placeholder={t('components.native-chat.notes.placeholder', 'Add a note')}
        maxLength={NATIVE_CHAT_NOTE_TEXT_MAX}
        onChange={(event) => editor.setDraftText(event.target.value)}
        onKeyDown={(event) => {
          if (isImeCompositionKeyDown(event)) {
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
        className="w-full resize-none bg-transparent text-sm text-media-paper-foreground outline-none placeholder:text-media-paper-muted"
      />
      <div className="flex items-center justify-end gap-2">
        {/* Near the limit, how much room is left, so text that stops going in isn't a surprise. */}
        {editor.draftText.length >= NOTE_TEXT_WARN ? (
          <span className="text-xs text-media-paper-muted tabular-nums">
            {editor.draftText.length} / {NATIVE_CHAT_NOTE_TEXT_MAX}
          </span>
        ) : null}
        <Button
          type="button"
          variant="media-note"
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
      className="my-1.5 rounded-lg border border-status-warning-border bg-status-warning-background p-2 text-xs text-media-paper-foreground"
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
          variant="media-note"
          size="xs"
          onClick={() => editor.commit() && onConfirmed(reason)}
        >
          {editor.pending
            ? t('components.native-chat.notes.addNote', 'Add note')
            : t('components.native-chat.notes.save', 'Save')}
        </Button>
        <Button
          type="button"
          variant="media-paper"
          size="xs"
          onClick={() => {
            editor.closeEditor()
            onConfirmed(reason)
          }}
        >
          {t('components.native-chat.notes.discard', 'Discard')}
        </Button>
        <Button
          type="button"
          variant="media-paper"
          size="xs"
          onClick={() => editor.setConfirm(null)}
        >
          {t('components.native-chat.notes.keepEditing', 'Keep editing')}
        </Button>
      </div>
    </div>
  )
}

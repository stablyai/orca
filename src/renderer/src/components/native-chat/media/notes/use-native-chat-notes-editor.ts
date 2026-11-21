import { useCallback, useMemo, useState } from 'react'
import {
  groupNativeChatNotesByFrame,
  NATIVE_CHAT_NOTE_MAX_FRAMES,
  renumberNativeChatNotes,
  type NativeChatMediaNote,
  type NativeChatNoteMark
} from './native-chat-media-notes'

/** What the panel's prompt asks about: an unadded note, or an unsaved change to one. */
export type NativeChatNotesConfirm = { reason: 'close' | 'done' | 'replace' | 'cancel' }

export type NativeChatNotesStatus =
  | { kind: 'removed'; count: number }
  | { kind: 'frame-limit' }
  | { kind: 'error'; message: string }

type Removed = { notes: NativeChatMediaNote[]; at: number[] }

let noteSequence = 0
const nextNoteId = (): string => `note-${Date.now().toString(36)}-${(noteSequence += 1)}`

/** The notes being made on one media item: placing, editing, removing (with Undo), and the unadded-note guard. */
export function useNativeChatNotesEditor(initial: {
  notes?: readonly NativeChatMediaNote[]
  /** Marks already drawn into the image; new numbers continue after them. */
  offset?: number
}) {
  const offset = initial.offset ?? 0
  const [notes, setNotes] = useState<NativeChatMediaNote[]>(() => [...(initial.notes ?? [])])
  const [pending, setPending] = useState<NativeChatMediaNote | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftText, setDraftText] = useState('')
  const [confirm, setConfirm] = useState<NativeChatNotesConfirm | null>(null)
  const [status, setStatus] = useState<NativeChatNotesStatus | null>(null)
  const [removed, setRemoved] = useState<Removed | null>(null)

  const editing = editingId ? (notes.find((note) => note.id === editingId) ?? null) : null
  // Opening a note to read it is not a change; only different words are unsaved.
  const hasUnadded = pending
    ? draftText.trim() !== ''
    : editing
      ? draftText.trim() !== '' && draftText.trim() !== editing.text
      : false

  const closeEditor = useCallback(() => {
    setPending(null)
    setEditingId(null)
    setDraftText('')
    setConfirm(null)
  }, [])

  /** Starts a note on a new mark; false when the user must first add or discard the open one. */
  const place = useCallback(
    (mark: NativeChatNoteMark, time?: number): boolean => {
      if (hasUnadded) {
        setConfirm({ reason: 'replace' })
        return false
      }
      const frames = groupNativeChatNotesByFrame(notes)
      const newFrame = !frames.some((group) => {
        const t = group[0]?.time
        return t === time || (t !== undefined && time !== undefined && Math.abs(t - time) < 0.02)
      })
      if (newFrame && frames.length >= NATIVE_CHAT_NOTE_MAX_FRAMES) {
        setStatus({ kind: 'frame-limit' })
        return false
      }
      setStatus(null)
      setEditingId(null)
      setDraftText('')
      setPending({
        id: nextNoteId(),
        number: offset + notes.length + 1,
        text: '',
        mark,
        ...(time === undefined ? {} : { time })
      })
      return true
    },
    [hasUnadded, notes, offset]
  )

  const open = useCallback(
    (id: string): boolean => {
      if (hasUnadded) {
        setConfirm({ reason: 'replace' })
        return false
      }
      const note = notes.find((entry) => entry.id === id)
      if (!note) {
        return false
      }
      setPending(null)
      setEditingId(id)
      setDraftText(note.text)
      return true
    },
    [hasUnadded, notes]
  )

  /** Adds the open note or saves the change; false when there are no words to keep. */
  const commit = useCallback((): boolean => {
    const text = draftText.trim()
    if (!text) {
      return false
    }
    if (pending) {
      setNotes((current) => [...current, { ...pending, text }])
    } else if (editingId) {
      setNotes((current) =>
        current.map((note) => (note.id === editingId ? { ...note, text } : note))
      )
    }
    closeEditor()
    return true
  }, [closeEditor, draftText, editingId, pending])

  const remove = useCallback(
    (id: string) => {
      const at = notes.findIndex((note) => note.id === id)
      if (at === -1) {
        return
      }
      const gone = notes[at]!
      setNotes(
        renumberNativeChatNotes(
          notes.filter((note) => note.id !== id),
          offset
        )
      )
      setPending((current) => (current ? { ...current, number: current.number - 1 } : current))
      if (editingId === id) {
        closeEditor()
      }
      setRemoved({ notes: [gone], at: [at] })
      setStatus({ kind: 'removed', count: 1 })
    },
    [closeEditor, editingId, notes, offset]
  )

  const clear = useCallback(() => {
    if (notes.length === 0) {
      return
    }
    setRemoved({ notes, at: notes.map((_, index) => index) })
    setNotes([])
    closeEditor()
    setStatus({ kind: 'removed', count: notes.length })
  }, [closeEditor, notes])

  const undo = useCallback((): boolean => {
    if (!removed) {
      return false
    }
    const next = [...notes]
    removed.notes.forEach((note, index) => next.splice(removed.at[index] ?? next.length, 0, note))
    setNotes(renumberNativeChatNotes(next, offset))
    setRemoved(null)
    setStatus(null)
    return true
  }, [notes, offset, removed])

  const move = useCallback((id: string, mark: NativeChatNoteMark) => {
    setPending((current) => (current?.id === id ? { ...current, mark } : current))
    setNotes((current) => current.map((note) => (note.id === id ? { ...note, mark } : note)))
  }, [])

  return useMemo(
    () => ({
      notes,
      pending,
      editing,
      draftText,
      setDraftText,
      hasUnadded,
      confirm,
      setConfirm,
      status,
      setStatus,
      canUndo: removed !== null,
      place,
      open,
      commit,
      closeEditor,
      remove,
      clear,
      undo,
      move
    }),
    [
      notes,
      pending,
      editing,
      draftText,
      hasUnadded,
      confirm,
      status,
      removed,
      place,
      open,
      commit,
      closeEditor,
      remove,
      clear,
      undo,
      move
    ]
  )
}

export type NativeChatNotesEditor = ReturnType<typeof useNativeChatNotesEditor>

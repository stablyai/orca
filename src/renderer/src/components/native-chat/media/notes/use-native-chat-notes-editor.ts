import { useCallback, useMemo, useRef, useState } from 'react'
import {
  groupNativeChatNotesByFrame,
  NATIVE_CHAT_NOTE_MAX_FRAMES,
  renumberNativeChatNotes,
  type NativeChatMediaNote,
  type NativeChatNoteMark
} from './native-chat-media-notes'

/** What the panel's prompt asks about: an unadded note, or an unsaved change to one. */
export type NativeChatNotesConfirm = { reason: 'close' | 'done' | 'replace' | 'cancel' | 'clear' }

export type NativeChatNotesStatus =
  | { kind: 'removed'; count: number }
  | { kind: 'frame-limit' }
  | { kind: 'error'; message: string }

/** Undo steps kept per viewer. */
const HISTORY_MAX = 50

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
  // Every change to the notes can be undone and redone, as in Orca's other annotation tools.
  const [past, setPast] = useState<NativeChatMediaNote[][]>([])
  const [future, setFuture] = useState<NativeChatMediaNote[][]>([])
  // While Send prepares the marked image, the notes it draws can't change under it.
  const lockedRef = useRef(false)
  const [locked, setLockedState] = useState(false)
  const setLocked = useCallback((next: boolean) => {
    lockedRef.current = next
    setLockedState(next)
  }, [])
  const record = useCallback((before: NativeChatMediaNote[]) => {
    setPast((current) => [...current.slice(1 - HISTORY_MAX), before])
    setFuture([])
  }, [])

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
      if (lockedRef.current) {
        return false
      }
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
      if (lockedRef.current) {
        return false
      }
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
    if (!text || lockedRef.current) {
      return false
    }
    record(notes)
    if (pending) {
      setNotes((current) => [...current, { ...pending, text }])
    } else if (editingId) {
      setNotes((current) =>
        current.map((note) => (note.id === editingId ? { ...note, text } : note))
      )
    }
    closeEditor()
    return true
  }, [closeEditor, draftText, editingId, notes, pending, record])

  const remove = useCallback(
    (id: string) => {
      const at = notes.findIndex((note) => note.id === id)
      if (at === -1 || lockedRef.current) {
        return
      }
      record(notes)
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
      setStatus({ kind: 'removed', count: 1 })
    },
    [closeEditor, editingId, notes, offset, record]
  )

  const clear = useCallback(() => {
    if (notes.length === 0 || lockedRef.current) {
      return
    }
    // Words not yet added would be lost with no Undo: they are added or discarded first, then Clear
    // goes on (the viewer finishes it once the answered note is settled).
    if (hasUnadded) {
      setConfirm({ reason: 'clear' })
      return
    }
    record(notes)
    setNotes([])
    closeEditor()
    setStatus({ kind: 'removed', count: notes.length })
  }, [closeEditor, hasUnadded, notes, record])

  /** Shows an earlier or later set of notes. A note being written stays open, numbered after them;
   *  an edit of a note that isn't in that set closes. */
  const applyHistory = useCallback(
    (shown: NativeChatMediaNote[]) => {
      setNotes(shown)
      setPending((current) => (current ? { ...current, number: offset + shown.length + 1 } : null))
      if (editingId && !shown.some((note) => note.id === editingId)) {
        closeEditor()
      }
      setStatus(null)
    },
    [closeEditor, editingId, offset]
  )

  const undo = useCallback((): boolean => {
    const previous = past.at(-1)
    if (!previous || lockedRef.current) {
      return false
    }
    setPast(past.slice(0, -1))
    setFuture((current) => [notes, ...current])
    applyHistory(previous)
    return true
  }, [applyHistory, notes, past])

  const redo = useCallback((): boolean => {
    const next = future[0]
    if (!next || lockedRef.current) {
      return false
    }
    setFuture(future.slice(1))
    setPast((current) => [...current, notes])
    applyHistory(next)
    return true
  }, [applyHistory, future, notes])

  /** Notes held from an earlier visit, once the viewer knows its chat. */
  const restore = useCallback(
    (held: readonly NativeChatMediaNote[]) => setNotes(renumberNativeChatNotes([...held], offset)),
    [offset]
  )

  const move = useCallback(
    (id: string, mark: NativeChatNoteMark) => {
      if (lockedRef.current) {
        return
      }
      setPending((current) => (current?.id === id ? { ...current, mark } : current))
      if (notes.some((note) => note.id === id)) {
        record(notes)
        setNotes((current) => current.map((note) => (note.id === id ? { ...note, mark } : note)))
      }
    },
    [notes, record]
  )

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
      canUndo: past.length > 0,
      locked,
      setLocked,
      place,
      open,
      commit,
      closeEditor,
      remove,
      clear,
      undo,
      redo,
      restore,
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
      past,
      locked,
      setLocked,
      redo,
      restore,
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

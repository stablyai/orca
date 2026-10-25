import { createBrowserUuid } from '@/lib/browser-uuid'
import type { NativeChatAnnotationAnchor } from './native-chat-annotation-anchor'
import {
  nativeChatAnnotationDeliveryStorage,
  removeSupersededNativeChatAnnotationDeliveries,
  withoutReservedNativeChatAnnotations,
  type NativeChatAnnotationDelivery
} from './native-chat-annotation-delivery'
import {
  isNativeChatAnnotationAnchor,
  isNativeChatAnnotationEditor,
  nativeChatAnnotationRevision,
  nativeChatAnnotationEditorRevision,
  nativeChatAnnotationStorageError,
  nativeChatAnnotationStorage
} from './native-chat-annotation-storage'

export type { NativeChatAnnotationAnchor } from './native-chat-annotation-anchor'
export {
  formatNativeChatAnnotations,
  prepareNativeChatAnnotatedMessage
} from './native-chat-annotation-delivery'

export type NativeChatAnnotation = NativeChatAnnotationAnchor & {
  id: string
  comment: string
  createdAt: number
  revision?: string
}

export type NativeChatAnnotationEditor = {
  anchor: NativeChatAnnotationAnchor
  id?: string
  comment: string
  revision?: string
}

export type NativeChatAnnotationsSnapshot = {
  notes: readonly NativeChatAnnotation[]
  editor?: NativeChatAnnotationEditor
  persistenceError?: string
}

export type NativeChatAnnotationsStore = {
  getSnapshot: () => NativeChatAnnotationsSnapshot
  subscribe: (listener: () => void) => () => void
  add: (anchor: NativeChatAnnotationAnchor, comment: string) => NativeChatAnnotation | null
  update: (id: string, comment: string) => boolean
  remove: (id: string) => boolean
  setEditor: (editor: NativeChatAnnotationEditor | undefined) => boolean
  consume: (notes: readonly NativeChatAnnotation[], editor?: NativeChatAnnotationEditor) => boolean
  clear: () => boolean
  retryPersistence: () => boolean
  reserve: (delivery: NativeChatAnnotationDelivery) => boolean
  settleDelivery: (messageId: string, outcome: 'accepted' | 'returned' | 'waiting') => boolean
}

const EMPTY: NativeChatAnnotationsSnapshot = { notes: [] }
const stores = new Map<string, NativeChatAnnotationsStore>()

const disabledStore: NativeChatAnnotationsStore = {
  getSnapshot: () => EMPTY,
  subscribe: () => () => {},
  add: () => null,
  update: () => false,
  remove: () => false,
  setEditor: () => false,
  consume: () => false,
  clear: () => false,
  retryPersistence: () => false,
  reserve: () => false,
  settleDelivery: () => false
}

export function getNativeChatAnnotationsStore(scopeKey?: string): NativeChatAnnotationsStore {
  if (!scopeKey) {
    return disabledStore
  }
  const existing = stores.get(scopeKey)
  if (existing) {
    return existing
  }
  const storage = nativeChatAnnotationStorage(scopeKey)
  const deliveries = nativeChatAnnotationDeliveryStorage(scopeKey)
  let snapshot = EMPTY
  const pending = new Map<string, NativeChatAnnotation>()
  const consumedNotes = new Map<string, NativeChatAnnotation>()
  const consumedEditors = new Map<string, NativeChatAnnotationEditor>()
  let pendingEditor: NativeChatAnnotationEditor | undefined
  const listeners = new Set<() => void>()
  const reportError = (error: unknown): false => {
    snapshot = { ...snapshot, persistenceError: nativeChatAnnotationStorageError(error) }
    listeners.forEach((listener) => listener())
    return false
  }
  const refresh = (): void => {
    let next: NativeChatAnnotationsSnapshot
    try {
      next = storage.read()
    } catch (error) {
      next = { ...snapshot, persistenceError: nativeChatAnnotationStorageError(error) }
    }
    const notes = new Map(next.notes.map((note) => [note.id, note]))
    for (const [id, note] of pending) {
      notes.set(id, note)
    }
    for (const note of consumedNotes.values()) {
      const current = notes.get(note.id)
      if (current && nativeChatAnnotationRevision(current) === nativeChatAnnotationRevision(note)) {
        notes.delete(note.id)
      }
    }
    next = {
      ...next,
      notes: [...notes.values()].sort(
        (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
      ),
      ...(pendingEditor ? { editor: pendingEditor } : {}),
      ...((pending.size > 0 ||
        pendingEditor ||
        consumedNotes.size > 0 ||
        consumedEditors.size > 0) &&
      snapshot.persistenceError
        ? { persistenceError: snapshot.persistenceError }
        : {})
    }
    if (
      next.editor === undefined ||
      consumedEditors.has(nativeChatAnnotationEditorRevision(next.editor))
    ) {
      delete next.editor
    }
    try {
      next = withoutReservedNativeChatAnnotations(next, deliveries.read())
    } catch (error) {
      next = { ...next, persistenceError: nativeChatAnnotationStorageError(error) }
    }
    if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
      snapshot = next
      listeners.forEach((listener) => listener())
    }
  }
  const persist = (): boolean => {
    try {
      // Migrate before mutating; a failed migration must leave the legacy copy intact.
      const saved = storage.read(true)
      if (saved.persistenceError) {
        throw new Error(saved.persistenceError)
      }
      for (const [id, note] of pending) {
        storage.writeNote(note)
        pending.delete(id)
      }
      for (const [revision, note] of consumedNotes) {
        storage.consumeNote(note)
        consumedNotes.delete(revision)
      }
      for (const [revision, editor] of consumedEditors) {
        storage.consumeEditor(editor)
        consumedEditors.delete(revision)
      }
      if (pendingEditor) {
        storage.writeEditor(pendingEditor)
        pendingEditor = undefined
      }
      refresh()
      return true
    } catch (error) {
      refresh()
      return reportError(error)
    }
  }
  const consume: NativeChatAnnotationsStore['consume'] = (notes, editor) => {
    refresh()
    for (const note of notes) {
      const unconfirmed = pending.get(note.id)
      if (
        unconfirmed &&
        nativeChatAnnotationRevision(unconfirmed) === nativeChatAnnotationRevision(note)
      ) {
        pending.delete(note.id)
      }
      consumedNotes.set(JSON.stringify([note.id, nativeChatAnnotationRevision(note)]), note)
    }
    if (editor) {
      if (
        pendingEditor &&
        nativeChatAnnotationEditorRevision(pendingEditor) ===
          nativeChatAnnotationEditorRevision(editor)
      ) {
        pendingEditor = undefined
      }
      consumedEditors.set(nativeChatAnnotationEditorRevision(editor), editor)
    }
    return persist()
  }
  const onStorage = (event: StorageEvent): void => {
    if (storage.matches(event.key)) {
      refresh()
    }
  }
  refresh()
  const store: NativeChatAnnotationsStore = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (listeners.size === 0) {
        window.addEventListener('storage', onStorage)
        refresh()
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          window.removeEventListener('storage', onStorage)
        }
      }
    },
    add: (anchor, comment) => {
      if (!isNativeChatAnnotationAnchor(anchor) || !comment.trim()) {
        return null
      }
      refresh()
      const note: NativeChatAnnotation = {
        ...anchor,
        id: createBrowserUuid(),
        revision: createBrowserUuid(),
        comment: comment.trim(),
        createdAt: Math.max(Date.now(), ...snapshot.notes.map((note) => note.createdAt + 1))
      }
      pending.set(note.id, note)
      persist()
      return note
    },
    update: (id, comment) => {
      refresh()
      const note = snapshot.notes.find((entry) => entry.id === id)
      if (!note || !comment.trim()) {
        return false
      }
      pending.set(id, { ...note, comment: comment.trim(), revision: createBrowserUuid() })
      persist()
      return true
    },
    remove: (id) => {
      refresh()
      const note = snapshot.notes.find((entry) => entry.id === id)
      if (!note) {
        return false
      }
      consume([note])
      return true
    },
    setEditor: (editor) => {
      if (editor !== undefined && !isNativeChatAnnotationEditor(editor)) {
        return false
      }
      if (editor === undefined) {
        refresh()
        consume([], snapshot.editor)
      } else {
        pendingEditor = { ...editor, anchor: { ...editor.anchor }, revision: createBrowserUuid() }
        persist()
      }
      return true
    },
    consume,
    clear: () => {
      refresh()
      return consume(snapshot.notes, snapshot.editor)
    },
    retryPersistence: persist,
    reserve: (delivery) => {
      if (!persist()) {
        return false
      }
      try {
        deliveries.write(delivery)
        refresh()
        return true
      } catch (error) {
        return reportError(error)
      }
    },
    settleDelivery: (messageId, outcome) => {
      try {
        const delivery = deliveries.read().find((entry) => entry.messageId === messageId)
        if (!delivery) {
          return true
        }
        if (outcome === 'accepted') {
          if (!consume(delivery.notes, delivery.editor)) {
            return false
          }
          removeSupersededNativeChatAnnotationDeliveries(deliveries, delivery)
        } else if ((delivery.returned === true) !== (outcome === 'returned')) {
          const { returned: _returned, ...waiting } = delivery
          deliveries.write(outcome === 'returned' ? { ...waiting, returned: true } : waiting)
        }
        refresh()
        return true
      } catch (error) {
        return reportError(error)
      }
    }
  }
  stores.set(scopeKey, store)
  return store
}

import { readNativeChatAnnotationRecord } from './native-chat-annotation-quarantine'
import type {
  NativeChatAnnotation,
  NativeChatAnnotationAnchor,
  NativeChatAnnotationEditor,
  NativeChatAnnotationsSnapshot
} from './native-chat-annotations-store'

export function nativeChatAnnotationStorageError(error: unknown): string {
  return error instanceof Error ? error.message : 'Annotations could not be saved.'
}

function hasValidRevision(value: object): boolean {
  return !('revision' in value) || (typeof value.revision === 'string' && value.revision.length > 0)
}

export function nativeChatAnnotationRevision(note: NativeChatAnnotation): string {
  return (
    note.revision ??
    JSON.stringify([
      note.id,
      note.createdAt,
      note.messageId,
      note.startOffset,
      note.quote,
      note.comment
    ])
  )
}

export function nativeChatAnnotationEditorRevision(editor: NativeChatAnnotationEditor): string {
  return (
    editor.revision ??
    JSON.stringify([
      editor.id,
      editor.anchor.messageId,
      editor.anchor.startOffset,
      editor.anchor.quote,
      editor.comment
    ])
  )
}

export function isNativeChatAnnotationAnchor(value: unknown): value is NativeChatAnnotationAnchor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'quote' in value &&
    typeof value.quote === 'string' &&
    value.quote.trim().length > 0 &&
    'messageId' in value &&
    typeof value.messageId === 'string' &&
    value.messageId.length > 0 &&
    'startOffset' in value &&
    typeof value.startOffset === 'number' &&
    Number.isSafeInteger(value.startOffset) &&
    value.startOffset >= 0
  )
}

export function isNativeChatAnnotation(value: unknown): value is NativeChatAnnotation {
  return (
    isNativeChatAnnotationAnchor(value) &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'comment' in value &&
    typeof value.comment === 'string' &&
    value.comment.trim().length > 0 &&
    'createdAt' in value &&
    typeof value.createdAt === 'number' &&
    Number.isFinite(value.createdAt) &&
    hasValidRevision(value)
  )
}

export function isNativeChatAnnotationEditor(value: unknown): value is NativeChatAnnotationEditor {
  return (
    typeof value === 'object' &&
    value !== null &&
    'anchor' in value &&
    isNativeChatAnnotationAnchor(value.anchor) &&
    'comment' in value &&
    typeof value.comment === 'string' &&
    hasValidRevision(value) &&
    (!('id' in value) ||
      value.id === undefined ||
      (typeof value.id === 'string' && value.id.length > 0))
  )
}

function isLegacySnapshot(value: unknown): value is NativeChatAnnotationsSnapshot & { version: 1 } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'version' in value &&
    value.version === 1 &&
    'notes' in value &&
    Array.isArray(value.notes) &&
    value.notes.every(isNativeChatAnnotation) &&
    new Set(value.notes.map((note) => note.id)).size === value.notes.length &&
    (!('editor' in value) ||
      value.editor === undefined ||
      isNativeChatAnnotationEditor(value.editor))
  )
}

export function nativeChatAnnotationStorage(scopeKey: string) {
  const legacyKey = `orca:native-chat-annotations:v1:${scopeKey}`
  const prefix = `orca:native-chat-annotations:v2:${encodeURIComponent(scopeKey)}:`
  const noteKey = (id: string): string => `${prefix}note:${encodeURIComponent(id)}`
  const editorKey = `${prefix}editor`
  const legacyNoteKey = (id: string): string => `${prefix}legacy-note:${encodeURIComponent(id)}`
  const legacyEditorKey = `${prefix}legacy-editor`
  const consumedNoteKey = (note: NativeChatAnnotation): string =>
    `${prefix}consumed-note:${encodeURIComponent(note.id)}:${encodeURIComponent(nativeChatAnnotationRevision(note))}`
  const consumedEditorKey = (editor: NativeChatAnnotationEditor): string =>
    `${prefix}consumed-editor:${encodeURIComponent(nativeChatAnnotationEditorRevision(editor))}`
  let readError: string | undefined
  const readRecord = <T>(key: string, validate: (value: unknown) => value is T): T | undefined =>
    readNativeChatAnnotationRecord(key, `${prefix}quarantine:`, validate, () => {
      readError = 'Saved annotations could not be read.'
    })
  const migrate = (): NativeChatAnnotationsSnapshot => {
    const value = readRecord(legacyKey, isLegacySnapshot)
    if (!value) {
      return { notes: [] }
    }
    const legacy: NativeChatAnnotationsSnapshot = {
      notes: value.notes,
      ...('editor' in value && isNativeChatAnnotationEditor(value.editor)
        ? { editor: value.editor }
        : {})
    }
    try {
      // Migration writes only seed records, never the slots edited by live windows.
      for (const note of legacy.notes) {
        localStorage.setItem(legacyNoteKey(note.id), JSON.stringify(note))
      }
      if (legacy.editor) {
        localStorage.setItem(legacyEditorKey, JSON.stringify(legacy.editor))
      }
      localStorage.removeItem(legacyKey)
      return legacy
    } catch (error) {
      return {
        ...legacy,
        persistenceError: nativeChatAnnotationStorageError(error)
      }
    }
  }
  return {
    matches: (key: string | null): boolean =>
      key === null || key === legacyKey || key.startsWith(prefix),
    read: (retry = false): NativeChatAnnotationsSnapshot => {
      if (retry) {
        readError = undefined
      }
      const legacy = migrate()
      const keys = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.key(index)
      )
      const inherited = new Map(legacy.notes.map((note) => [note.id, note]))
      const current = new Map<string, NativeChatAnnotation>()
      for (const key of keys) {
        if (
          !key ||
          (!key.startsWith(`${prefix}note:`) && !key.startsWith(`${prefix}legacy-note:`))
        ) {
          continue
        }
        const note = readRecord(
          key,
          (value): value is NativeChatAnnotation =>
            isNativeChatAnnotation(value) &&
            (key === noteKey(value.id) || key === legacyNoteKey(value.id))
        )
        if (!note) {
          continue
        }
        if (key === noteKey(note.id)) {
          current.set(note.id, note)
        } else {
          inherited.set(note.id, note)
        }
      }
      // A consumed current record still takes precedence over its old migration seed.
      for (const [id, note] of current) {
        inherited.set(id, note)
      }
      const notes = [...inherited.values()].filter(
        (note) => localStorage.getItem(consumedNoteKey(note)) === null
      )
      notes.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      const editor =
        readRecord(editorKey, isNativeChatAnnotationEditor) ??
        readRecord(legacyEditorKey, isNativeChatAnnotationEditor) ??
        legacy.editor
      return {
        notes,
        ...(legacy.persistenceError || readError
          ? { persistenceError: legacy.persistenceError ?? readError }
          : {}),
        ...(editor === undefined || localStorage.getItem(consumedEditorKey(editor)) !== null
          ? {}
          : { editor })
      }
    },
    writeNote: (note: NativeChatAnnotation): void =>
      localStorage.setItem(noteKey(note.id), JSON.stringify(note)),
    // A revision marker never removes a different window's newer value.
    consumeNote: (note: NativeChatAnnotation): void =>
      localStorage.setItem(consumedNoteKey(note), '1'),
    consumeEditor: (editor: NativeChatAnnotationEditor): void =>
      localStorage.setItem(consumedEditorKey(editor), '1'),
    writeEditor: (editor: NativeChatAnnotationEditor): void =>
      localStorage.setItem(editorKey, JSON.stringify(editor))
  }
}

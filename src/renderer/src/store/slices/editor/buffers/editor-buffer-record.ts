import type { OpenFile } from '../types/open-file'
import {
  editorBufferIdOfView,
  editorBufferViewIds,
  type EditorBufferDetachments,
  type EditorBufferViewIndex
} from './editor-buffer-views'
import type { EditorBufferKeepRequest, EditorBufferKeptRecords } from './editor-buffer-kept'

/**
 * Source of truth for a file's buffer state, keyed by record id (the file identity, or the tab id
 * for views that never share). The same fields on every view's `OpenFile` are a mirror written in
 * the same store update so existing readers keep working.
 */
export type EditorBufferRecord = Pick<
  OpenFile,
  'isDirty' | 'lastKnownDiskSignature' | 'externalMutation' | 'pendingOwnerMigration'
>

export type EditorBufferRecords = Record<string, EditorBufferRecord>

/** What a buffer write replaces. */
export type EditorBufferWrite = { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords }

export type EditorBufferState = EditorBufferWrite &
  EditorBufferViewIndex & {
    editorDrafts?: Record<string, string>
    editorBufferDetached?: EditorBufferDetachments
    editorBufferKept?: EditorBufferKeptRecords
    editorBufferKeepRequest?: EditorBufferKeepRequest
  }

export const EDITOR_BUFFER_FIELDS = [
  'isDirty',
  'lastKnownDiskSignature',
  'externalMutation',
  'pendingOwnerMigration'
] as const satisfies readonly (keyof EditorBufferRecord)[]

export function editorBufferRecordFromFile(file: OpenFile): EditorBufferRecord {
  return {
    isDirty: file.isDirty,
    lastKnownDiskSignature: file.lastKnownDiskSignature,
    externalMutation: file.externalMutation,
    pendingOwnerMigration: file.pendingOwnerMigration
  }
}

/** The file's record; a missing one is seeded from the tab, never from defaults. */
export function editorBufferOf(
  state: Pick<EditorBufferState, 'editorBuffers' | 'editorBufferIdOf' | 'editorBufferViews'>,
  file: OpenFile
): EditorBufferRecord {
  return (
    state.editorBuffers[editorBufferIdOfView(state, file.id)] ?? editorBufferRecordFromFile(file)
  )
}

export function editorBufferMirrorMismatch(
  file: OpenFile,
  record: EditorBufferRecord
): keyof EditorBufferRecord | null {
  return EDITOR_BUFFER_FIELDS.find((field) => !Object.is(file[field], record[field])) ?? null
}

/** Writes `patch` to the file's record and every view's mirror in one update; `tabPatch` lands on `fileId` only. */
export function writeEditorBuffer(
  state: EditorBufferState,
  fileId: string,
  patch: Partial<EditorBufferRecord>,
  tabPatch?: Partial<OpenFile>
): EditorBufferWrite {
  const recordId = editorBufferIdOfView(state, fileId)
  const viewIds = new Set(editorBufferViewIds(state, recordId))
  viewIds.add(fileId)
  let editorBuffers = state.editorBuffers
  const openFiles = state.openFiles.map((file) => {
    if (!viewIds.has(file.id)) {
      return file
    }
    if (editorBuffers === state.editorBuffers) {
      editorBuffers = {
        ...editorBuffers,
        [recordId]: { ...(editorBuffers[recordId] ?? editorBufferRecordFromFile(file)), ...patch }
      }
    }
    return file.id === fileId ? { ...file, ...tabPatch, ...patch } : { ...file, ...patch }
  })
  return { openFiles, editorBuffers }
}

/** Writes `patch` through the file's record; returns `state` itself when the record already holds it. */
export function updateEditorBuffer<TState extends EditorBufferState>(
  state: TState,
  fileId: string,
  patch: Partial<EditorBufferRecord>
): TState | EditorBufferWrite {
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file) {
    return state
  }
  const record = editorBufferOf(state, file)
  // Why the mirror too: a view must never keep showing a value its record no longer holds.
  const changes = EDITOR_BUFFER_FIELDS.some(
    (field) =>
      Object.hasOwn(patch, field) &&
      (!Object.is(record[field], patch[field]) || !Object.is(file[field], patch[field]))
  )
  return changes ? writeEditorBuffer(state, fileId, patch) : state
}

/**
 * A host-mirrored tab carries the host's buffer state, so its record adopts it in the same write,
 * and every view mirrors the record's dirty flag. Dirty is the OR of the record's
 * mirrored views: an older host publishes it per tab. `views` is `openFiles` with that flag
 * mirrored; the caller's session-sync patch writes it.
 */
export function adoptMirroredEditorBuffers(
  records: EditorBufferRecords,
  openFiles: OpenFile[],
  index: EditorBufferViewIndex
): { editorBuffers: EditorBufferRecords; views: OpenFile[] } {
  const adopted = new Map<string, EditorBufferRecord>()
  for (const file of openFiles) {
    const recordId = editorBufferIdOfView(index, file.id)
    if (file.mirroredFromRuntimeSession !== true) {
      continue
    }
    const prior = adopted.get(recordId)
    adopted.set(
      recordId,
      prior
        ? { ...prior, isDirty: prior.isDirty || file.isDirty }
        : editorBufferRecordFromFile(file)
    )
  }
  let editorBuffers = records
  for (const [recordId, record] of adopted) {
    const current = records[recordId]
    if (
      current &&
      EDITOR_BUFFER_FIELDS.every((field) => Object.is(current[field], record[field]))
    ) {
      continue
    }
    editorBuffers = editorBuffers === records ? { ...records } : editorBuffers
    editorBuffers[recordId] = record
  }
  let mirrored = false
  const nextOpenFiles = openFiles.map((file) => {
    const record = adopted.get(editorBufferIdOfView(index, file.id))
    // Why dirty only: it is the one field ORed across views; the rest each view publishes itself.
    if (!record || file.isDirty === record.isDirty) {
      return file
    }
    mirrored = true
    return { ...file, isDirty: record.isDirty }
  })
  return { editorBuffers, views: mirrored ? nextOpenFiles : openFiles }
}

const MOVED_EDITOR_BUFFER_PREFIX = 'moved:'
const CARRIED_EDITOR_BUFFER_PREFIX = 'carried:'

/** A record a rename carried to its new path, before the middleware joins it there. */
export function isMovedEditorBufferId(recordId: string): boolean {
  return recordId.startsWith(MOVED_EDITOR_BUFFER_PREFIX)
}

/**
 * Carries each migrated tab's record to its new tab id in the same update that re-keys the tab.
 * The record waits under a transient id; the record middleware then joins it to the record its new
 * identity names. `rename` marks the file's content as moved there, which wins over a clean
 * record already at the new path.
 */
export function rekeyEditorBuffers(
  state: Pick<EditorBufferState, 'editorBuffers' | 'editorBufferIdOf' | 'editorBufferViews'>,
  openFiles: readonly OpenFile[],
  migrations: ReadonlyMap<string, string>,
  kind: 'rename' | 'carry',
  patchFor?: (file: OpenFile) => Partial<EditorBufferRecord> | undefined
): Pick<EditorBufferState, 'editorBuffers' | 'editorBufferIdOf'> {
  const moved = openFiles.filter((file) => migrations.has(file.id))
  if (moved.length === 0) {
    return { editorBuffers: state.editorBuffers, editorBufferIdOf: state.editorBufferIdOf }
  }
  const editorBuffers = { ...state.editorBuffers }
  const editorBufferIdOf = { ...state.editorBufferIdOf }
  const prefix = kind === 'rename' ? MOVED_EDITOR_BUFFER_PREFIX : CARRIED_EDITOR_BUFFER_PREFIX
  for (const file of moved) {
    const carried = `${prefix}${editorBufferIdOfView(state, file.id)}`
    editorBuffers[carried] ??= { ...editorBufferOf(state, file), ...patchFor?.(file) }
    delete editorBufferIdOf[file.id]
  }
  // Why a second pass: a swap of two ids must not delete the entry it just wrote.
  for (const file of moved) {
    const newId = migrations.get(file.id) ?? file.id
    editorBufferIdOf[newId] = `${prefix}${editorBufferIdOfView(state, file.id)}`
  }
  return { editorBuffers, editorBufferIdOf }
}

/** Keeps one record per record id of the open tabs: seeds a record from its first view, drops ones with no view. */
export function reconcileEditorBufferMembership(
  records: EditorBufferRecords,
  openFiles: readonly OpenFile[],
  index: EditorBufferViewIndex
): EditorBufferRecords {
  let next = records
  const ids = new Set<string>()
  for (const file of openFiles) {
    const recordId = editorBufferIdOfView(index, file.id)
    ids.add(recordId)
    if (!Object.hasOwn(next, recordId)) {
      next = next === records ? { ...records } : next
      next[recordId] = editorBufferRecordFromFile(file)
    }
  }
  for (const id of Object.keys(next)) {
    if (!ids.has(id)) {
      next = next === records ? { ...records } : next
      delete next[id]
    }
  }
  return next
}

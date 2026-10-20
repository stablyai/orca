import type { OpenFile } from '../types/open-file'
import type { EditorBufferIdentity } from './editor-buffer-identity'

/**
 * Source of truth for the buffer state of one physical file, shared by every edit tab showing it.
 * The same fields on each tab are a mirror written in the same store update.
 */
export type EditorBufferRecord = Pick<
  OpenFile,
  | 'isDirty'
  | 'lastKnownDiskSignature'
  | 'externalMutation'
  | 'pendingDiskBaselineVerification'
  | 'pendingLiveDiskVerification'
  | 'pendingOwnerMigration'
>

export type EditorBufferRecords = Record<string, EditorBufferRecord>

export type EditorBufferKey = {
  identity: EditorBufferIdentity
  /** Fixed per record: a record kept apart from a same-file record gets its own model. */
  modelOwnerKey: string
  /** The tab whose unsaved draft the record carries; absent while the record is clean. */
  draftOwner?: EditorBufferDraftOwner
}

export type EditorBufferDraftOwner = Pick<
  OpenFile,
  'worktreeId' | 'relativePath' | 'runtimeEnvironmentId'
>

export type EditorBufferIndex = {
  recordIdByFileId: Record<string, string>
  /** Only records that can be shared; the rest belong to one tab. */
  keyByRecordId: Record<string, EditorBufferKey>
}

export const EMPTY_EDITOR_BUFFER_INDEX: EditorBufferIndex = {
  recordIdByFileId: {},
  keyByRecordId: {}
}

type EditorBufferIndexState = { editorBufferIndex?: EditorBufferIndex }

/** A tab without an index entry (fixtures, a store without sharing) owns a record under its id. */
export function editorBufferIdOf(state: EditorBufferIndexState, fileId: string): string {
  return state.editorBufferIndex?.recordIdByFileId[fileId] ?? fileId
}

/** Any open tab still showing the record, e.g. after the tab that started a read closed. */
export function liveEditorBufferViewOf(
  state: EditorBufferIndexState & { openFiles: readonly OpenFile[] },
  recordId: string
): string | undefined {
  return state.openFiles.find((file) => editorBufferIdOf(state, file.id) === recordId)?.id
}

/** Every open tab sharing `fileId`'s record, `fileId` first. */
export function editorBufferViewIds(
  state: EditorBufferIndexState & { openFiles: readonly OpenFile[] },
  fileId: string
): string[] {
  // Why: a closed tab's id may name a record other tabs still show; it must not reach them.
  if (state.editorBufferIndex && !(fileId in state.editorBufferIndex.recordIdByFileId)) {
    return [fileId]
  }
  const recordId = editorBufferIdOf(state, fileId)
  const ids = [fileId]
  for (const file of state.openFiles) {
    if (file.id !== fileId && editorBufferIdOf(state, file.id) === recordId) {
      ids.push(file.id)
    }
  }
  return ids
}

export const EDITOR_BUFFER_FIELDS = [
  'isDirty',
  'lastKnownDiskSignature',
  'externalMutation',
  'pendingDiskBaselineVerification',
  'pendingLiveDiskVerification',
  'pendingOwnerMigration'
] as const satisfies readonly (keyof EditorBufferRecord)[]

export function editorBufferRecordFromFile(file: OpenFile): EditorBufferRecord {
  return {
    isDirty: file.isDirty,
    lastKnownDiskSignature: file.lastKnownDiskSignature,
    externalMutation: file.externalMutation,
    pendingDiskBaselineVerification: file.pendingDiskBaselineVerification,
    pendingLiveDiskVerification: file.pendingLiveDiskVerification,
    pendingOwnerMigration: file.pendingOwnerMigration
  }
}

/** The file's record; a missing one is seeded from the tab, never from defaults. */
export function editorBufferOf(
  records: EditorBufferRecords,
  file: OpenFile,
  recordId = file.id
): EditorBufferRecord {
  return records[recordId] ?? editorBufferRecordFromFile(file)
}

export function editorBufferMirrorMismatch(
  file: OpenFile,
  record: EditorBufferRecord
): keyof EditorBufferRecord | null {
  return EDITOR_BUFFER_FIELDS.find((field) => !Object.is(file[field], record[field])) ?? null
}

/** Writes `patch` to one file's record and every tab mirroring it in one update. */
export function writeEditorBuffer(
  state: EditorBufferIndexState & { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords },
  fileId: string,
  patch: Partial<EditorBufferRecord>,
  tabPatch?: Partial<OpenFile>
): { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords } {
  const recordId = editorBufferIdOf(state, fileId)
  let editorBuffers = state.editorBuffers
  const openFiles = state.openFiles.map((file) => {
    if (file.id !== fileId && editorBufferIdOf(state, file.id) !== recordId) {
      return file
    }
    if (editorBuffers === state.editorBuffers) {
      editorBuffers = {
        ...editorBuffers,
        [recordId]: { ...editorBufferOf(editorBuffers, file, recordId), ...patch }
      }
    }
    return { ...file, ...(file.id === fileId ? tabPatch : undefined), ...patch }
  })
  return { openFiles, editorBuffers }
}

/** (Re)creates records for tabs whose buffer state comes from outside the store, e.g. a host snapshot. */
export function createEditorBuffers(
  records: EditorBufferRecords,
  files: readonly OpenFile[],
  state: EditorBufferIndexState = {}
): EditorBufferRecords {
  if (files.length === 0) {
    return records
  }
  const next = { ...records }
  for (const file of files) {
    next[editorBufferIdOf(state, file.id)] = editorBufferRecordFromFile(file)
  }
  return next
}

/**
 * Points each migrated tab at its record under its new id. A patch applies to the whole record:
 * a pause set or cleared for one tab of a file holds for every tab of it.
 */
export function rekeyEditorBuffers(
  state: EditorBufferIndexState & { openFiles: OpenFile[]; editorBuffers: EditorBufferRecords },
  migrations: ReadonlyMap<string, string>,
  patchFor?: (file: OpenFile) => Partial<EditorBufferRecord> | undefined
): Pick<Required<EditorBufferIndexState>, 'editorBufferIndex'> & {
  editorBuffers: EditorBufferRecords
} {
  const index = state.editorBufferIndex ?? EMPTY_EDITOR_BUFFER_INDEX
  const moved = state.openFiles.filter((file) => migrations.has(file.id))
  if (moved.length === 0) {
    return { editorBuffers: state.editorBuffers, editorBufferIndex: index }
  }
  const recordIdByFileId = { ...index.recordIdByFileId }
  const editorBuffers = { ...state.editorBuffers }
  // Why two passes: a swap of two ids must not delete the entry it just wrote.
  for (const file of moved) {
    delete recordIdByFileId[file.id]
  }
  for (const file of moved) {
    const recordId = editorBufferIdOf(state, file.id)
    recordIdByFileId[migrations.get(file.id) ?? file.id] = recordId
    editorBuffers[recordId] = {
      ...editorBufferOf(state.editorBuffers, file, recordId),
      ...editorBuffers[recordId],
      ...patchFor?.(file)
    }
  }
  return { editorBuffers, editorBufferIndex: { ...index, recordIdByFileId } }
}

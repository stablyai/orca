import type { StateCreator } from 'zustand'
import {
  editorBufferMirrorMismatch,
  reconcileEditorBufferMembership,
  type EditorBufferState
} from './slices/editor/buffers/editor-buffer-record'
import {
  editorBufferIdOfView,
  editorBufferViewIndexMismatch,
  reconcileEditorBufferViewIndex,
  type EditorBufferViewIndex
} from './slices/editor/buffers/editor-buffer-views'

/**
 * Ties editor buffer records and their view index to `openFiles` membership inside the same
 * write: a new tab joins (or seeds) its record and a record with no view left is dropped. Field
 * writes go through the record (`writeEditorBuffer`); with `checkInvariant` a write that drifts
 * a view from its record throws.
 */
function reconcileEditorBuffers<TState extends EditorBufferState>(
  state: TState,
  write: TState | Partial<TState>,
  checkInvariant: boolean
): TState | Partial<TState> {
  const openFiles = write.openFiles ?? state.openFiles
  const records = write.editorBuffers ?? state.editorBuffers
  const drafts = write.editorDrafts ?? state.editorDrafts
  if (openFiles === state.openFiles && records === state.editorBuffers) {
    // Why only drafts: this runs per keystroke, and nothing else about the views changed.
    if (checkInvariant && drafts !== state.editorDrafts) {
      assertEditorBufferDraftsAgree({ ...state, ...write }, drafts)
    }
    return write
  }
  const index = reconcileEditorBufferViewIndex(
    {
      editorBufferIdOf: write.editorBufferIdOf ?? state.editorBufferIdOf,
      editorBufferViews: write.editorBufferViews ?? state.editorBufferViews
    },
    openFiles
  )
  const next = reconcileEditorBufferMembership(records, openFiles, index)
  if (checkInvariant) {
    assertEditorBufferInvariant({ openFiles, editorBuffers: next, editorDrafts: drafts, ...index })
  }
  const indexChanged =
    index.editorBufferIdOf !== state.editorBufferIdOf ||
    index.editorBufferViews !== state.editorBufferViews
  if (next === records && !indexChanged) {
    return write
  }
  return {
    ...write,
    editorBuffers: next,
    ...(indexChanged ? index : {})
  }
}

/** Every view of a shared record holds the same `editorDrafts` entry. */
export function assertEditorBufferDraftsAgree(
  index: EditorBufferViewIndex,
  drafts: Readonly<Record<string, string>> | undefined
): void {
  for (const viewIds of Object.values(index.editorBufferViews)) {
    const [first, ...rest] = viewIds
    const differing = rest.find((id) => !Object.is(drafts?.[first], drafts?.[id]))
    if (differing !== undefined) {
      throw new Error(`Editor draft of ${differing} differs from another view of its record`)
    }
  }
}

/**
 * Against the index: every view's record exists, every record has a view, and every view of a
 * record holds the same mirror fields and the same `editorDrafts` entry.
 */
export function assertEditorBufferRecordsMatchViews(state: EditorBufferState): void {
  const recordIds = new Set(state.openFiles.map((file) => editorBufferIdOfView(state, file.id)))
  const keys = Object.keys(state.editorBuffers)
  if (keys.length !== recordIds.size || keys.some((id) => !recordIds.has(id))) {
    throw new Error('Editor buffer records are not keyed by the open editor tabs')
  }
  for (const file of state.openFiles) {
    const record = state.editorBuffers[editorBufferIdOfView(state, file.id)]
    const field = editorBufferMirrorMismatch(file, record)
    if (field !== null) {
      throw new Error(`Editor buffer mirror "${field}" of ${file.id} differs from its record`)
    }
  }
  assertEditorBufferDraftsAgree(state, state.editorDrafts)
}

/** The index matches the open tabs, and the records match the index. */
export function assertEditorBufferInvariant(state: EditorBufferState): void {
  const indexMismatch = editorBufferViewIndexMismatch(state, state.openFiles)
  if (indexMismatch !== null) {
    throw new Error(indexMismatch)
  }
  assertEditorBufferRecordsMatchViews(state)
}

export function withEditorBufferRecords<TState extends EditorBufferState>(
  createState: StateCreator<TState, [], []>,
  checkInvariant: boolean = import.meta.env.DEV
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    const wrap = (write: typeof set): typeof set => {
      const wrapped = (
        partial: TState | Partial<TState> | ((state: TState) => TState | Partial<TState>),
        replace?: boolean
      ): void => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the caller's own partial/replace pair; with replace=true the updater still yields a full state.
        ;(write as (next: (state: TState) => TState | Partial<TState>, replace?: boolean) => void)(
          (state) =>
            reconcileEditorBuffers(
              state,
              typeof partial === 'function' ? partial(state) : partial,
              checkInvariant
            ),
          replace
        )
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one implementation serves both zustand setState overloads.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState)
    return createState(wrap(set), get, api)
  }
}

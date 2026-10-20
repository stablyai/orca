import type { StateCreator } from 'zustand'
import type { OpenFile } from './slices/editor/types/open-file'
import {
  editorBufferMirrorMismatch,
  editorBufferRecordFromFile,
  reconcileEditorBufferMembership,
  type EditorBufferRecords
} from './slices/editor/buffers/editor-buffer-record'

type EditorBufferState = {
  openFiles: OpenFile[]
  editorBuffers: EditorBufferRecords
}

/**
 * Ties editor buffer records to `openFiles` membership inside the same write, so open, hydrate,
 * close and teardown never need their own record bookkeeping. Slice writes must route the six
 * buffer fields through the record; dev and test builds throw when a tab mirror drifts from it.
 */
function reconcileEditorBuffers<TState extends EditorBufferState>(
  state: TState,
  write: TState | Partial<TState>,
  adoptMirrorDrift: boolean
): TState | Partial<TState> {
  const openFiles = write.openFiles ?? state.openFiles
  const records = write.editorBuffers ?? state.editorBuffers
  if (openFiles === state.openFiles && records === state.editorBuffers) {
    return write
  }
  let next = reconcileEditorBufferMembership(records, openFiles)
  for (const file of openFiles) {
    const field = editorBufferMirrorMismatch(file, next[file.id])
    if (field === null) {
      continue
    }
    // Why adopt outside dev: a missed writer must keep main's behaviour, not revert the tab.
    if (!adoptMirrorDrift && import.meta.env.DEV) {
      throw new Error(
        `Editor buffer mirror "${field}" of ${file.id} was written without its record`
      )
    }
    next = next === records ? { ...records } : next
    next[file.id] = editorBufferRecordFromFile(file)
  }
  return next === records ? write : { ...write, editorBuffers: next }
}

export function assertEditorBufferInvariant(state: EditorBufferState): void {
  const ids = new Set(state.openFiles.map((file) => file.id))
  const recordIds = Object.keys(state.editorBuffers)
  if (recordIds.length !== ids.size || recordIds.some((id) => !ids.has(id))) {
    throw new Error('Editor buffer records are not keyed by the open editor tabs')
  }
  for (const file of state.openFiles) {
    const field = editorBufferMirrorMismatch(file, state.editorBuffers[file.id])
    if (field !== null) {
      throw new Error(`Editor buffer mirror "${field}" of ${file.id} differs from its record`)
    }
  }
}

export function withEditorBufferRecords<TState extends EditorBufferState>(
  createState: StateCreator<TState, [], []>
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    // Why external writes adopt: `useAppStore.setState` is the fixture/seed path, like hydrate.
    const wrap = (write: typeof set, adoptMirrorDrift: boolean): typeof set => {
      const wrapped = (
        partial: TState | Partial<TState> | ((state: TState) => TState | Partial<TState>),
        replace?: boolean
      ): void => {
        const before = get()
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards the caller's own partial/replace pair; with replace=true the updater still yields a full state.
        ;(write as (next: (state: TState) => TState | Partial<TState>, replace?: boolean) => void)(
          (state) =>
            reconcileEditorBuffers(
              state,
              typeof partial === 'function' ? partial(state) : partial,
              adoptMirrorDrift
            ),
          replace
        )
        const after = get()
        if (
          import.meta.env.DEV &&
          (after.openFiles !== before.openFiles || after.editorBuffers !== before.editorBuffers)
        ) {
          assertEditorBufferInvariant(after)
        }
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: one implementation serves both zustand setState overloads.
      return wrapped as typeof set
    }
    api.setState = wrap(api.setState, true)
    return createState(wrap(set, false), get, api)
  }
}

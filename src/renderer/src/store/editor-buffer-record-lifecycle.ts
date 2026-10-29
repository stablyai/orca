import type { StateCreator } from 'zustand'
import {
  editorBufferMirrorMismatch,
  type EditorBufferState
} from './slices/editor/buffers/editor-buffer-record'
import {
  editorBufferIdOfView,
  editorBufferViewIndexMismatch,
  type EditorBufferViewIndex
} from './slices/editor/buffers/editor-buffer-views'
import {
  editorBufferIdForFile,
  editorBufferRouteInputsChanged,
  type EditorBufferRouteState
} from './slices/editor/buffers/editor-buffer-identity-cache'
import { reconcileEditorBufferRecords } from './slices/editor/buffers/editor-buffer-reconcile'
import {
  reconciledEditorBufferState,
  showEditorBufferView
} from './slices/editor/buffers/editor-buffer-reconcile-write'
import {
  isEditorBufferRejoinDue,
  mayRejoinAfterDraftWrite
} from './slices/editor/buffers/editor-buffer-rejoin'

type EditorBufferStoreState = EditorBufferState & EditorBufferRouteState

const NO_DRAFTS: Record<string, string> = {}
const NO_DETACHMENTS = {}
const NO_KEPT = {}

/** Reconcile views/records atomically with openFiles identity/membership; same-file views join by identity rules and unreferenced records retire. Write fields via writeEditorBuffer; checkInvariant rejects mirror drift. */
function reconcileEditorBuffers<TState extends EditorBufferStoreState>(
  state: TState,
  requested: TState | Partial<TState>,
  checkInvariant: boolean,
  scheduleRejoin: () => void
): TState | Partial<TState> {
  const keepRequest = requested.editorBufferKeepRequest
  let write = requested
  if (Object.hasOwn(write, 'editorBufferKeepRequest')) {
    write = { ...write }
    delete write.editorBufferKeepRequest
  }
  const openFiles = write.openFiles ?? state.openFiles
  const records = write.editorBuffers ?? state.editorBuffers
  const drafts = write.editorDrafts ?? state.editorDrafts
  const detachments = write.editorBufferDetached ?? state.editorBufferDetached
  const kept = write.editorBufferKept ?? state.editorBufferKept
  if (
    openFiles === state.openFiles &&
    records === state.editorBuffers &&
    detachments === state.editorBufferDetached &&
    kept === state.editorBufferKept &&
    !editorBufferRouteInputsChanged(state, write)
  ) {
    // Why only drafts: this runs per keystroke, and nothing else about the views changed.
    if (checkInvariant && drafts !== state.editorDrafts) {
      assertEditorBufferDraftsAgree({ ...state, ...write }, drafts)
    }
    // Why: clearing a draft can make a detached side clean, which rejoins it.
    if (
      drafts !== state.editorDrafts &&
      mayRejoinAfterDraftWrite(state, detachments, state.editorDrafts, drafts) &&
      isEditorBufferRejoinDue({
        openFiles,
        editorBuffers: records,
        editorDrafts: drafts ?? NO_DRAFTS,
        editorBufferIdOf: state.editorBufferIdOf,
        editorBufferViews: state.editorBufferViews,
        editorBufferDetached: detachments ?? NO_DETACHMENTS,
        editorBufferKept: kept ?? NO_KEPT
      })
    ) {
      scheduleRejoin()
    }
    return write
  }
  const routeState: EditorBufferRouteState = { ...state, ...write }
  const input = {
    openFiles,
    editorBuffers: records,
    editorDrafts: drafts ?? NO_DRAFTS,
    editorBufferIdOf: write.editorBufferIdOf ?? state.editorBufferIdOf,
    editorBufferViews: write.editorBufferViews ?? state.editorBufferViews,
    editorBufferDetached: detachments ?? NO_DETACHMENTS,
    editorBufferKept: kept ?? NO_KEPT
  }
  // Rejoin only on identity passes: clean-then-clear-draft settlement must not adopt another draft between steps.
  const rejoin = Object.hasOwn(write, 'editorBufferIdentityRevision')
  const result = reconcileEditorBufferRecords(
    input,
    (file) => editorBufferIdForFile(file, routeState),
    keepRequest && { ...keepRequest, drafts: state.editorDrafts ?? NO_DRAFTS },
    rejoin
  )
  const changed: Partial<EditorBufferState> = {}
  const mirrors = result.viewMirrors
  if (mirrors.size > 0) {
    changed.openFiles = openFiles.map((file) => showEditorBufferView(file, mirrors.get(file.id)))
  }
  const next = reconciledEditorBufferState(result, changed.openFiles ?? openFiles)
  if (!rejoin && isEditorBufferRejoinDue(next)) {
    scheduleRejoin()
  }
  if (checkInvariant) {
    assertEditorBufferInvariant(next)
  }
  if (next.editorBuffers !== state.editorBuffers) {
    changed.editorBuffers = next.editorBuffers
  }
  if (next.editorDrafts !== input.editorDrafts) {
    changed.editorDrafts = next.editorDrafts
  }
  if (next.editorBufferIdOf !== state.editorBufferIdOf) {
    changed.editorBufferIdOf = next.editorBufferIdOf
  }
  if (next.editorBufferViews !== state.editorBufferViews) {
    changed.editorBufferViews = next.editorBufferViews
  }
  if (next.editorBufferDetached !== input.editorBufferDetached) {
    changed.editorBufferDetached = next.editorBufferDetached
  }
  if (next.editorBufferKept !== input.editorBufferKept) {
    changed.editorBufferKept = next.editorBufferKept
  }
  if (Object.keys(changed).length === 0) {
    return write
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every key in `changed` is an EditorBufferState field TState extends, holding that field's type.
  return { ...write, ...(changed as Partial<TState>) }
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

/** Require index/tab agreement, no orphan records, and identical mirror fields/draft entries for every shared view. */
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

export function withEditorBufferRecords<TState extends EditorBufferStoreState>(
  createState: StateCreator<TState, [], []>,
  checkInvariant: boolean = import.meta.env.DEV
): StateCreator<TState, [], []> {
  return (set, get, api) => {
    let rejoinQueued = false
    const scheduleRejoin = (): void => {
      if (rejoinQueued) {
        return
      }
      rejoinQueued = true
      queueMicrotask(() => {
        rejoinQueued = false
        const bump: Partial<EditorBufferStoreState> = {
          editorBufferIdentityRevision: (api.getState().editorBufferIdentityRevision ?? 0) + 1
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: editorBufferIdentityRevision is an EditorBufferRouteState field TState extends.
        api.setState(bump as Partial<TState>)
      })
    }
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
              checkInvariant,
              scheduleRejoin
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

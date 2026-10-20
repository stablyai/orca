import type { StateCreator } from 'zustand'
import type { OpenFile } from './slices/editor/types/open-file'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import {
  EMPTY_EDITOR_BUFFER_INDEX,
  editorBufferIdOf,
  editorBufferMirrorMismatch,
  type EditorBufferIndex,
  type EditorBufferRecords
} from './slices/editor/buffers/editor-buffer-record'
import { editorBufferIdentityOf } from './slices/editor/buffers/editor-buffer-identity'
import { reconcileEditorBufferSharing } from './slices/editor/buffers/editor-buffer-sharing'
import { editorModelOwnerInputsChanged } from '@/components/editor/editor-model-owner'
import { appendRecoveredEditorDrafts } from './slices/editor/buffers/recovered-editor-drafts'
import type { RecoveredEditorDraft } from '../../../shared/workspace-session-state-types'

type EditorBufferState = WorktreeOperationRouteState & {
  openFiles: OpenFile[]
  editorBuffers: EditorBufferRecords
  editorBufferIndex?: EditorBufferIndex
  editorDrafts?: Record<string, string>
  recoveredEditorDrafts?: RecoveredEditorDraft[]
  activeFileId?: string | null
  activeFileIdByWorktree?: Record<string, string | null>
  lastVisitedAtByWorktreeId?: Record<string, number>
}

/**
 * Why: the most recently active tab's draft is the one the user last worked in. A workspace's
 * active tab ranks by when the workspace was last visited; with no visit times, the active
 * workspace wins.
 */
function editorDraftPreference(state: EditorBufferState, fileId: string): number {
  if (state.activeFileId === fileId) {
    return Number.POSITIVE_INFINITY
  }
  const worktreeId = state.openFiles.find((file) => file.id === fileId)?.worktreeId
  if (worktreeId === undefined || state.activeFileIdByWorktree?.[worktreeId] !== fileId) {
    return 0
  }
  // Visit keys are bare ids or `${executionHostId}|${worktreeId}`.
  const visited = Object.entries(state.lastVisitedAtByWorktreeId ?? {}).reduce(
    (latest, [key, at]) =>
      key === worktreeId || key.endsWith(`|${worktreeId}`) ? Math.max(latest, at) : latest,
    0
  )
  return 1 + visited + (worktreeId === state.activeWorktreeId ? 0.5 : 0)
}

/**
 * Ties editor buffer records to `openFiles` membership inside the same write, so open, hydrate,
 * close and teardown never need their own record bookkeeping, and tabs showing one file share one
 * record. Slice writes must route the six buffer fields through the record; dev and test builds
 * throw when a tab mirror drifts from it.
 */
function reconcileEditorBuffers<TState extends EditorBufferState>(
  state: TState,
  write: TState | Partial<TState>,
  adoptMirrorDrift: boolean
): TState | Partial<TState> {
  const openFiles = write.openFiles ?? state.openFiles
  const records = write.editorBuffers ?? state.editorBuffers
  const index = write.editorBufferIndex ?? state.editorBufferIndex ?? EMPTY_EDITOR_BUFFER_INDEX
  const ownersChanged = editorModelOwnerInputsChanged(state, write)
  if (
    openFiles === state.openFiles &&
    records === state.editorBuffers &&
    index === state.editorBufferIndex &&
    !ownersChanged
  ) {
    return write
  }
  let routeState: EditorBufferState | null = null
  const merged = (): EditorBufferState => (routeState ??= { ...state, ...write })
  const drafts = write.editorDrafts ?? state.editorDrafts ?? {}
  const result = reconcileEditorBufferSharing({
    openFiles,
    records,
    index,
    drafts,
    previousRecords: state.editorBuffers,
    previousFiles: ownersChanged ? null : new Map(state.openFiles.map((file) => [file.id, file])),
    identityOf: (file) => editorBufferIdentityOf(file, merged()),
    draftPreference: (fileId) => editorDraftPreference(merged(), fileId),
    now: Date.now,
    onMirrorDrift: (file, field) => {
      // Why adopt outside dev: a missed writer must keep main's behaviour, not revert the tab.
      if (!adoptMirrorDrift && import.meta.env.DEV) {
        throw new Error(
          `Editor buffer mirror "${field}" of ${file.id} was written without its record`
        )
      }
    }
  })
  return {
    ...write,
    ...(result.openFiles.every((file, index) => file === openFiles[index])
      ? {}
      : { openFiles: result.openFiles }),
    ...(result.records === records ? {} : { editorBuffers: result.records }),
    ...(result.index === index ? {} : { editorBufferIndex: result.index }),
    ...(result.drafts === drafts ? {} : { editorDrafts: result.drafts }),
    ...(result.recovered.length === 0
      ? {}
      : {
          recoveredEditorDrafts: appendRecoveredEditorDrafts(
            write.recoveredEditorDrafts ?? state.recoveredEditorDrafts ?? [],
            result.recovered
          )
        })
  }
}

export function assertEditorBufferInvariant(state: EditorBufferState): void {
  const viewedRecords = new Set<string>()
  for (const file of state.openFiles) {
    const recordId = editorBufferIdOf(state, file.id)
    const record = state.editorBuffers[recordId]
    if (record === undefined) {
      throw new Error(`Editor tab ${file.id} has no buffer record`)
    }
    viewedRecords.add(recordId)
    const field = editorBufferMirrorMismatch(file, record)
    if (field !== null) {
      throw new Error(`Editor buffer mirror "${field}" of ${file.id} differs from its record`)
    }
  }
  if (
    Object.keys(state.editorBuffers).some((recordId) => !viewedRecords.has(recordId)) ||
    (state.editorBufferIndex !== undefined &&
      Object.keys(state.editorBufferIndex.recordIdByFileId).length !== state.openFiles.length)
  ) {
    throw new Error('Editor buffer records are not keyed by the open editor tabs')
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

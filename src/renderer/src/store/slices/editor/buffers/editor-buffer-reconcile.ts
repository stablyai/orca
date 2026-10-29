import type { OpenFile } from '../types/open-file'
import { editorBufferRecordFromFile, isMovedEditorBufferId } from './editor-buffer-record'
import {
  decideEditorBufferJoin,
  isDirtyEditorBufferSide,
  type EditorBufferJoinSide
} from './editor-buffer-join'
import { staysDetached } from './editor-buffer-rejoin'
import type { EditorBufferKeepRequest } from './editor-buffer-kept'
import { detachedEditorBufferId, type EditorBufferDetachments } from './editor-buffer-views'
import {
  IndexBuilder,
  ReconcileWrite,
  sameDetachments,
  sameIndex,
  type EditorBufferReconcileResult,
  type EditorBufferReconcileState
} from './editor-buffer-reconcile-write'

/** Join moved/opened/hydrated/reowned views by identity (rekey/attach/adopt/merge/detach), preserving unchanged references. Rename carries new disk content: clean targets attach, dirty targets detach. rejoin admits clean partners; keep preserves dirty closed-view records. Return required view mirrors atomically. */
export function reconcileEditorBufferRecords(
  state: EditorBufferReconcileState,
  identityOf: (file: OpenFile) => string,
  keep?: EditorBufferKeepRequest & { drafts: Readonly<Record<string, string>> },
  rejoin = false
): EditorBufferReconcileResult {
  const detached: EditorBufferDetachments = {}
  const desired = new Map<string, string>()
  const open = new Set(state.openFiles.map((file) => file.id))
  for (const file of state.openFiles) {
    const identity = identityOf(file)
    const entry = state.editorBufferDetached[file.id]
    // Why: a detachment holds only while the view still names the identity it was kept off.
    if (
      entry &&
      (entry.retired || (entry.key === identity && (!rejoin || staysDetached(state, entry, open))))
    ) {
      detached[file.id] = entry
      desired.set(file.id, entry.recordId)
    } else {
      desired.set(file.id, identity)
    }
  }

  const write = new ReconcileWrite(state)
  const index = new IndexBuilder()
  const kept = new Set<string>()
  const moving: OpenFile[] = []
  const seen = new Set<string>()
  for (const file of state.openFiles) {
    // Why: a degenerate open-file list can repeat an id; both entries are one view.
    if (seen.has(file.id)) {
      continue
    }
    seen.add(file.id)
    const recordId = desired.get(file.id) ?? file.id
    if (
      state.editorBufferIdOf[file.id] === recordId &&
      Object.hasOwn(state.editorBuffers, recordId)
    ) {
      kept.add(file.id)
    } else {
      moving.push(file)
    }
  }
  // Why the previous order: views list in the order they joined.
  for (const [recordId, viewIds] of Object.entries(state.editorBufferViews)) {
    for (const viewId of viewIds) {
      if (
        kept.has(viewId) &&
        index.idOf[viewId] === undefined &&
        state.editorBufferIdOf[viewId] === recordId
      ) {
        index.place(viewId, recordId)
      }
    }
  }
  for (const viewId of kept) {
    if (index.idOf[viewId] === undefined) {
      index.place(viewId, state.editorBufferIdOf[viewId])
    }
  }

  // Route later views to their source record’s first destination without joining again.
  const landedFrom = new Map<string, { want: string; landed: string }>()
  for (const file of moving) {
    const want = desired.get(file.id) ?? file.id
    const source = state.editorBufferIdOf[file.id]
    const followed = source === undefined ? undefined : landedFrom.get(source)
    if (followed && followed.want === want) {
      index.place(file.id, followed.landed)
      const firstDetachment = Object.values(detached).find((d) => d.recordId === followed.landed)
      if (firstDetachment) {
        detached[file.id] = firstDetachment
      }
      continue
    }
    const sourceRecord = source === undefined ? undefined : state.editorBuffers[source]
    const joining: EditorBufferJoinSide = {
      record: sourceRecord ?? editorBufferRecordFromFile(file),
      draft: state.editorDrafts[file.id]
    }
    const landed = joinView(file.id, want, joining, source, write, index, detached)
    if (source !== undefined) {
      landedFrom.set(source, { want, landed })
    }
  }

  // Drop unviewed records unless no-prompt close requested retention.
  for (const recordId of Object.keys(write.records)) {
    if (!index.views[recordId]?.length) {
      const viewIds = state.editorBufferViews[recordId] ?? []
      const record = state.editorBuffers[recordId]
      // Why the drafts before this write: the closing write drops the closed views' drafts.
      const side = {
        record,
        draft: viewIds[0] === undefined ? undefined : keep?.drafts[viewIds[0]]
      }
      if (
        keep &&
        viewIds.length > 0 &&
        viewIds.every((id) => keep.viewIds.has(id)) &&
        isDirtyEditorBufferSide(side)
      ) {
        write.setKept(recordId, { ...side, viewIds, notice: keep.notice })
      }
      write.records = write.records === state.editorBuffers ? { ...write.records } : write.records
      delete write.records[recordId]
    }
  }
  const built = index.build()
  const indexSame = sameIndex(built, state)
  return {
    viewMirrors: write.viewMirrors(),
    editorBuffers: write.records,
    editorDrafts: write.drafts,
    editorBufferIdOf: indexSame ? state.editorBufferIdOf : built.editorBufferIdOf,
    editorBufferViews: indexSame ? state.editorBufferViews : built.editorBufferViews,
    editorBufferDetached: sameDetachments(detached, state.editorBufferDetached)
      ? state.editorBufferDetached
      : detached,
    editorBufferKept: write.kept
  }
}

/** Joins one moving view onto `want`; returns the record id it lands on. */
function joinView(
  viewId: string,
  want: string,
  joining: EditorBufferJoinSide,
  source: string | undefined,
  write: ReconcileWrite,
  index: IndexBuilder,
  detached: EditorBufferDetachments
): string {
  const targetViews = [...(index.views[want] ?? [])]
  if (targetViews.length === 0) {
    const kept = write.kept[want]
    const join = kept ? decideEditorBufferJoin(kept, joining) : 'rekey'
    if (kept && source !== undefined && isMovedEditorBufferId(source)) {
      // Why: the moved file replaced the kept text's file on disk; the notice still offers the text.
      write.setKept(want, undefined)
    } else if (kept && (join === 'attach' || join === 'merge')) {
      write.setKept(want, undefined)
      write.setRecord(want, kept.record)
      write.showView(viewId, kept)
      index.place(viewId, want)
      return want
    } else if (kept) {
      // Why detached: divergent text leaves the kept record, and the model at its address, alone.
      return detachView(viewId, want, joining, write, index, detached)
    }
    write.setRecord(want, joining.record)
    index.place(viewId, want)
    return want
  }
  const target: EditorBufferJoinSide = {
    record: write.records[want],
    draft: write.drafts[targetViews[0]]
  }
  const adopt = (): string => {
    write.setRecord(want, joining.record)
    for (const targetView of targetViews) {
      write.showView(targetView, joining)
    }
    index.place(viewId, want)
    return want
  }
  if (source !== undefined && isMovedEditorBufferId(source)) {
    if (!isDirtyEditorBufferSide(target)) {
      return adopt()
    }
    // Why: the renamed file replaced the target on disk; its unsaved edits stay on their own record.
    const keptOff = detachedEditorBufferId(targetViews[0])
    write.setRecord(keptOff, target.record)
    index.move(want, keptOff)
    for (const targetView of targetViews) {
      detached[targetView] = { recordId: keptOff, key: want }
    }
    write.setRecord(want, joining.record)
    index.place(viewId, want)
    return want
  }
  switch (decideEditorBufferJoin(target, joining)) {
    case 'rekey':
    case 'adopt':
      return adopt()
    case 'attach': {
      // Why: a clean view that saw the file deleted must not lose the banner by joining a clean record.
      const carriesDeleted =
        joining.record.externalMutation === 'deleted' &&
        target.record.externalMutation === undefined &&
        !isDirtyEditorBufferSide(target)
      const joined = carriesDeleted
        ? { ...target, record: { ...target.record, externalMutation: 'deleted' as const } }
        : target
      if (carriesDeleted) {
        write.setRecord(want, joined.record)
        for (const targetView of targetViews) {
          write.showView(targetView, joined)
        }
      }
      write.showView(viewId, joined)
      index.place(viewId, want)
      return want
    }
    case 'merge':
      // Why: the joining view's mirror must read the record, including its dirty flag.
      write.showView(viewId, target)
      index.place(viewId, want)
      return want
    case 'detach':
      return detachView(viewId, want, joining, write, index, detached)
  }
}

function detachView(
  viewId: string,
  want: string,
  joining: EditorBufferJoinSide,
  write: ReconcileWrite,
  index: IndexBuilder,
  detached: EditorBufferDetachments
): string {
  const keptOff = detachedEditorBufferId(viewId)
  write.setRecord(keptOff, joining.record)
  detached[viewId] = { recordId: keptOff, key: want }
  index.place(viewId, keptOff)
  return keptOff
}

import type { OpenFile } from '../types/open-file'
import {
  EDITOR_BUFFER_FIELDS,
  type EditorBufferRecord,
  type EditorBufferRecords
} from './editor-buffer-record'
import type { EditorBufferJoinSide } from './editor-buffer-join'
import type { EditorBufferKeptRecords } from './editor-buffer-kept'
import type { EditorBufferDetachments, EditorBufferViewIndex } from './editor-buffer-views'

export type EditorBufferReconcileState = EditorBufferViewIndex & {
  openFiles: OpenFile[]
  editorBuffers: EditorBufferRecords
  editorDrafts: Record<string, string>
  editorBufferDetached: EditorBufferDetachments
  editorBufferKept: EditorBufferKeptRecords
}

type Drafts = Record<string, string>

/** Copy-on-write accumulators for one reconcile pass. */
export class ReconcileWrite {
  records: EditorBufferRecords
  drafts: Drafts
  kept: EditorBufferKeptRecords
  readonly mirrors = new Map<string, EditorBufferRecord>()

  constructor(private readonly input: EditorBufferReconcileState) {
    this.records = input.editorBuffers
    this.drafts = input.editorDrafts
    this.kept = input.editorBufferKept
  }

  setKept(recordId: string, entry: EditorBufferKeptRecords[string] | undefined): void {
    this.kept = this.kept === this.input.editorBufferKept ? { ...this.kept } : this.kept
    if (entry) {
      this.kept[recordId] = entry
    } else {
      delete this.kept[recordId]
    }
  }

  setRecord(recordId: string, record: EditorBufferRecord): void {
    if (this.records[recordId] === record) {
      return
    }
    this.records = this.records === this.input.editorBuffers ? { ...this.records } : this.records
    this.records[recordId] = record
  }

  /** Writes a view's mirror fields and draft from the record it now belongs to. */
  showView(viewId: string, side: EditorBufferJoinSide): void {
    this.mirrors.set(viewId, side.record)
    if (this.drafts[viewId] === side.draft) {
      return
    }
    this.drafts = this.drafts === this.input.editorDrafts ? { ...this.drafts } : this.drafts
    if (side.draft === undefined) {
      delete this.drafts[viewId]
    } else {
      this.drafts[viewId] = side.draft
    }
  }

  /** The views whose mirror fields now differ from their record, keyed by view id. */
  viewMirrors(): ReadonlyMap<string, EditorBufferRecord> {
    const changed = new Map<string, EditorBufferRecord>()
    for (const file of this.input.openFiles) {
      const record = this.mirrors.get(file.id)
      if (record && !EDITOR_BUFFER_FIELDS.every((field) => Object.is(file[field], record[field]))) {
        changed.set(file.id, record)
      }
    }
    return changed
  }
}

/** Reconcile output: `viewMirrors` names content updates only, so `openFiles` membership stays put. */
export type EditorBufferReconcileResult = Omit<EditorBufferReconcileState, 'openFiles'> & {
  viewMirrors: ReadonlyMap<string, EditorBufferRecord>
}

export function showEditorBufferView(
  file: OpenFile,
  record: EditorBufferRecord | undefined
): OpenFile {
  return record ? { ...file, ...record } : file
}

/** The state after a reconcile, with `openFiles` as the caller wrote it. */
export function reconciledEditorBufferState(
  result: EditorBufferReconcileResult,
  openFiles: OpenFile[]
): EditorBufferReconcileState {
  return { ...result, openFiles }
}

export class IndexBuilder {
  readonly idOf: Record<string, string> = {}
  readonly views: Record<string, string[]> = {}

  place(viewId: string, recordId: string): void {
    this.idOf[viewId] = recordId
    ;(this.views[recordId] ??= []).push(viewId)
  }

  /** Moves every view of `from` to `to`. */
  move(from: string, to: string): void {
    for (const viewId of this.views[from] ?? []) {
      this.place(viewId, to)
    }
    delete this.views[from]
  }

  build(): EditorBufferViewIndex {
    for (const [recordId, viewIds] of Object.entries(this.views)) {
      if (viewIds.length === 0) {
        delete this.views[recordId]
      }
    }
    return { editorBufferIdOf: this.idOf, editorBufferViews: this.views }
  }
}

export function sameIndex(a: EditorBufferViewIndex, b: EditorBufferViewIndex): boolean {
  const aIds = Object.keys(a.editorBufferIdOf)
  const aRecords = Object.keys(a.editorBufferViews)
  return (
    aIds.length === Object.keys(b.editorBufferIdOf).length &&
    aIds.every((id) => b.editorBufferIdOf[id] === a.editorBufferIdOf[id]) &&
    aRecords.length === Object.keys(b.editorBufferViews).length &&
    aRecords.every((id) => {
      const other = b.editorBufferViews[id]
      const own = a.editorBufferViews[id]
      return other?.length === own.length && own.every((view, index) => other[index] === view)
    })
  )
}

export function sameDetachments(a: EditorBufferDetachments, b: EditorBufferDetachments): boolean {
  const ids = Object.keys(a)
  return ids.length === Object.keys(b).length && ids.every((id) => a[id] === b[id])
}

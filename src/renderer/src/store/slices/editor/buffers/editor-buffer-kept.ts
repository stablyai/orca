import type { EditorBufferRecord } from './editor-buffer-record'

/** Keep dirty records/models after last-view no-prompt removal. No writer means no autosave; reopened identities join them. */
export type EditorBufferKept = {
  record: EditorBufferRecord
  draft: string | undefined
  /** The views that closed; their model stays alive while the record is kept. */
  viewIds: readonly string[]
  /** The removal notice offering the text back; dismissing it releases only its own records. */
  notice: number
}

export type EditorBufferKeptRecords = Record<string, EditorBufferKept>

/** Closing writes carry editorBufferKeepRequest for record middleware; consume without storing it. */
export type EditorBufferKeepRequest = {
  viewIds: ReadonlySet<string>
  notice: number
}

/** One write can close views two purges asked to keep. */
export function mergeEditorBufferKeepRequests(
  a: EditorBufferKeepRequest | undefined,
  b: EditorBufferKeepRequest | undefined
): EditorBufferKeepRequest | undefined {
  if (!a || !b) {
    return a ?? b
  }
  return { viewIds: new Set([...a.viewIds, ...b.viewIds]), notice: b.notice }
}

/** Whether `viewId` closed into a kept record, so its model must stay alive. */
export function isKeptEditorBufferView(kept: EditorBufferKeptRecords, viewId: string): boolean {
  return Object.values(kept).some((entry) => entry.viewIds.includes(viewId))
}

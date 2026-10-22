import type { OpenFile } from '../types/open-file'

/**
 * Which editor tabs (views) show which buffer record. Maintained by the record middleware in the
 * same store update as `openFiles`, so every entry point resolves views through one index.
 */
export type EditorBufferViewIndex = {
  /** View (tab) id → record id. */
  editorBufferIdOf: Record<string, string>
  /** Record id → its view ids, in the order they joined. */
  editorBufferViews: Record<string, readonly string[]>
}

export const EMPTY_EDITOR_BUFFER_VIEW_INDEX: EditorBufferViewIndex = {
  editorBufferIdOf: {},
  editorBufferViews: {}
}

/** The record a tab belongs to. One record per tab until views of one file share a record. */
export function editorBufferIdForFile(file: OpenFile): string {
  return file.id
}

/** A tab that isn't open has no record yet, so it answers for itself. */
export function editorBufferIdOfView(index: EditorBufferViewIndex, viewId: string): string {
  return index.editorBufferIdOf[viewId] ?? viewId
}

export function editorBufferViewIds(
  index: EditorBufferViewIndex,
  recordId: string
): readonly string[] {
  return index.editorBufferViews[recordId] ?? [recordId]
}

/** Every view sharing `viewId`'s record, including `viewId` itself. */
export function editorBufferSiblingViewIds(
  index: EditorBufferViewIndex,
  viewId: string
): readonly string[] {
  return editorBufferViewIds(index, editorBufferIdOfView(index, viewId))
}

export function isLastEditorBufferView(index: EditorBufferViewIndex, viewId: string): boolean {
  return editorBufferSiblingViewIds(index, viewId).every((id) => id === viewId)
}

function buildEditorBufferViewIndex(openFiles: readonly OpenFile[]): EditorBufferViewIndex {
  const editorBufferIdOf: Record<string, string> = {}
  const editorBufferViews: Record<string, string[]> = {}
  for (const file of openFiles) {
    const recordId = editorBufferIdForFile(file)
    editorBufferIdOf[file.id] = recordId
    ;(editorBufferViews[recordId] ??= []).push(file.id)
  }
  return { editorBufferIdOf, editorBufferViews }
}

/** Whether every open tab already maps to the record `index` gives it; no allocation. */
function indexCoversTabs(index: EditorBufferViewIndex, openFiles: readonly OpenFile[]): boolean {
  return (
    openFiles.length === Object.keys(index.editorBufferIdOf).length &&
    openFiles.every((file) => index.editorBufferIdOf[file.id] === editorBufferIdForFile(file))
  )
}

/** The index for `openFiles`; returns `previous` itself when no tab joined, left or moved record. */
export function reconcileEditorBufferViewIndex(
  previous: EditorBufferViewIndex,
  openFiles: readonly OpenFile[]
): EditorBufferViewIndex {
  return indexCoversTabs(previous, openFiles) ? previous : buildEditorBufferViewIndex(openFiles)
}

function sameMembers(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && b.every((id) => a.includes(id))
}

/** Why the index is wrong for `openFiles`, or null when it is consistent. */
export function editorBufferViewIndexMismatch(
  index: EditorBufferViewIndex,
  openFiles: readonly OpenFile[]
): string | null {
  const expected = buildEditorBufferViewIndex(openFiles)
  const recordIds = Object.keys(expected.editorBufferViews)
  const consistent =
    indexCoversTabs(index, openFiles) &&
    recordIds.length === Object.keys(index.editorBufferViews).length &&
    recordIds.every((id) =>
      sameMembers(index.editorBufferViews[id], expected.editorBufferViews[id])
    )
  return consistent ? null : 'Editor buffer view index does not match the open editor tabs'
}

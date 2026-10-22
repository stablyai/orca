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

/**
 * A view kept off the record its identity names. `key` is that identity, so the view rejoins once
 * one side is clean; `retired` views (their environment now names another machine) never do.
 */
export type EditorBufferDetachment = { recordId: string; key: string; retired?: true }

export type EditorBufferDetachments = Record<string, EditorBufferDetachment>

const DETACHED_EDITOR_BUFFER_PREFIX = 'detached:'

/**
 * A record id no identity key can equal. Divergent dirty drafts of one file move here until they
 * rejoin; records on a retired environment move here for good.
 */
export function detachedEditorBufferId(viewId: string): string {
  return `${DETACHED_EDITOR_BUFFER_PREFIX}${viewId}`
}

export function isDetachedEditorBufferId(recordId: string): boolean {
  return recordId.startsWith(DETACHED_EDITOR_BUFFER_PREFIX)
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

/** The index that puts each tab on the record `recordIdOf` names, with no joins. */
export function buildEditorBufferViewIndex(
  openFiles: readonly OpenFile[],
  recordIdOf: (file: OpenFile) => string
): EditorBufferViewIndex {
  const editorBufferIdOf: Record<string, string> = {}
  const editorBufferViews: Record<string, string[]> = {}
  for (const file of openFiles) {
    const recordId = recordIdOf(file)
    editorBufferIdOf[file.id] = recordId
    ;(editorBufferViews[recordId] ??= []).push(file.id)
  }
  return { editorBufferIdOf, editorBufferViews }
}

/** Why the index is wrong for `openFiles`, or null when it is consistent. */
export function editorBufferViewIndexMismatch(
  index: EditorBufferViewIndex,
  openFiles: readonly OpenFile[]
): string | null {
  const viewIds = Object.keys(index.editorBufferIdOf)
  const listed = Object.values(index.editorBufferViews)
  // Why unique ids: a degenerate open-file list can repeat an id, and both entries are one view.
  const consistent =
    new Set(openFiles.map((file) => file.id)).size === viewIds.length &&
    openFiles.every((file) => Object.hasOwn(index.editorBufferIdOf, file.id)) &&
    listed.reduce((count, views) => count + views.length, 0) === viewIds.length &&
    Object.entries(index.editorBufferViews).every(
      ([recordId, views]) =>
        views.length > 0 && views.every((id) => index.editorBufferIdOf[id] === recordId)
    )
  return consistent ? null : 'Editor buffer view index does not match the open editor tabs'
}

import { closedEditorTabOrder } from '../closing/recently-closed-editor-tabs'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AppState } from '../../../types'
import type { EditorSet, EditorGet } from '../types/editor-set-get'
import { createRecentlyClosedTabPositionIndex } from '../../tabs/recently-closed-tab-position'
import { pushRecentlyClosedTabKind } from '../../tabs/recently-closed-tabs'
import { MAX_RECENT_CLOSED_EDITOR_TABS } from '../types/open-file'
import { isEditorTabContentType } from './editor-tab-content-type'
import { flushClosingEditorBuffers } from '@/components/editor/save/flush/editor-pending-flush'
import { editorBufferSiblingViewIds } from '../buffers/editor-buffer-views'
import { openWorkspaceEditorItem } from './workspace-editor-item'
import { notifyHostOfMirroredEditorClose } from '@/runtime/web-session-tabs-sync/closing/close-mirrored-editor-tab'
import {
  editorContentIsReferenced,
  editorPlacementIndex,
  openFileIndex
} from './workspace-editor-files'

/** Capture placements before their groups disappear; a bulk close publishes history once. */
export function editorTabsRetirement(
  set: EditorSet,
  get: EditorGet,
  before: AppState,
  tabs: readonly Tab[]
) {
  const files = openFileIndex(before.openFiles)
  const positions = new Map<string, ReturnType<typeof createRecentlyClosedTabPositionIndex>>()
  const views = tabs.flatMap((tab) => {
    const file = isEditorTabContentType(tab.contentType) ? files.get(tab.entityId) : undefined
    if (!file) {
      return []
    }
    let index = positions.get(tab.worktreeId)
    if (!index) {
      index = createRecentlyClosedTabPositionIndex(before, tab.worktreeId)
      positions.set(tab.worktreeId, index)
    }
    return [{ tab, file, position: index.positionFor(file.id, tab.id) }]
  })
  return () => {
    const current = get()
    const placements = editorPlacementIndex(current.unifiedTabsByWorktree)
    const closed = views.filter(({ tab }) => !placements.workspaceByTabId.has(tab.id))
    if (closed.length === 0) {
      return
    }
    set((state) => {
      let history = state.recentlyClosedEditorTabsByWorktree
      let kinds = state.recentlyClosedTabKindsByWorktree
      const counts = new Map<string, number>()
      for (const { tab, file, position } of closed) {
        if (
          file.mode === 'markdown-preview' ||
          (file.isUntitled && !file.isDirty && !before.editorDrafts[file.id])
        ) {
          continue
        }
        const { id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snapshot } = file
        if (history === state.recentlyClosedEditorTabsByWorktree) {
          history = { ...history }
        }
        history[tab.worktreeId] = [
          { ...snapshot, reopenId: id, ...(position ? { position } : {}) },
          ...(history[tab.worktreeId] ?? [])
        ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
        counts.set(tab.worktreeId, (counts.get(tab.worktreeId) ?? 0) + 1)
      }
      for (const [workspaceId, count] of counts) {
        kinds = pushRecentlyClosedTabKind(kinds, workspaceId, 'editor', count)
      }
      const closedIdsByWorkspace = new Map<string, Set<string>>()
      for (const { tab } of closed) {
        const ids = closedIdsByWorkspace.get(tab.worktreeId) ?? new Set<string>()
        ids.add(tab.id)
        if (!placements.workspacesByEntityId.get(tab.entityId)?.has(tab.worktreeId)) {
          ids.add(tab.entityId)
        }
        closedIdsByWorkspace.set(tab.worktreeId, ids)
      }
      return {
        recentlyClosedEditorTabsByWorktree: history,
        recentlyClosedTabKindsByWorktree: kinds,
        ...closedEditorTabOrder(state, closedIdsByWorkspace)
      }
    })
    // The tabs already left the strip, so closeFile can no longer name the host's tabs. The last view
    // of a file dirty when the close began (Save with only the host's draft) keeps its host tab.
    for (const { file, tab } of closed) {
      if (!file.isDirty || placements.workspacesByEntityId.get(tab.entityId)?.has(tab.worktreeId)) {
        notifyHostOfMirroredEditorClose(before, tab.worktreeId, file.id, tab.id)
      }
    }
    const released = new Map(closed.map(({ file, tab }) => [file.id, tab.worktreeId]))
    for (const [id, workspaceId] of released) {
      releaseUnreferencedEditorContent(get, id, workspaceId)
    }
  }
}

export function editorTabRetirement(set: EditorSet, get: EditorGet, before: AppState, tab: Tab) {
  const retire = editorTabsRetirement(set, get, before, [tab])
  const fileId = tab.entityId
  const fileBefore = isEditorTabContentType(tab.contentType)
    ? openFileIndex(before.openFiles).get(fileId)
    : undefined
  if (fileBefore?.mode !== 'edit' || fileBefore.isDirty || fileBefore.readOnly) {
    return retire
  }

  return () => {
    const state = get()
    if (
      openFileIndex(state.openFiles).get(fileId)?.isDirty &&
      !editorBufferSiblingViewIds(state, fileId).some((id) => editorContentIsReferenced(state, id))
    ) {
      // The close was approved while clean; keep text typed before the owner's frame arrived.
      flushClosingEditorBuffers(state, [fileId])
      const latest = get()
      if (openFileIndex(latest.openFiles).get(fileId)?.isDirty) {
        openWorkspaceEditorItem(
          latest,
          fileId,
          tab.worktreeId,
          fileBefore.relativePath,
          'editor',
          false,
          tab.groupId,
          'none'
        )
        return
      }
    }
    retire()
  }
}

export function releaseUnreferencedEditorContent(
  get: EditorGet,
  entityId: string,
  placementWorkspaceId?: string
): void {
  const state = get()
  if (openFileIndex(state.openFiles).has(entityId) && !editorContentIsReferenced(state, entityId)) {
    state.closeFile(entityId, { captureRecentlyClosed: false, placementWorkspaceId })
  }
}

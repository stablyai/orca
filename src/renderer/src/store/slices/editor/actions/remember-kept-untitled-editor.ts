import { findWorktreeById } from '../../worktree-helpers'
import type { EditorSet } from '../types/editor-set-get'
import {
  type ClosedEditorTabSnapshot,
  MAX_RECENT_CLOSED_EDITOR_TABS,
  type OpenFile
} from '../types/open-file'
import {
  insertRecentlyClosedTabKind,
  type RecentlyClosedTabPosition
} from '../../recently-closed-tabs'

export function placeClosedEditorSnapshot(
  stack: ClosedEditorTabSnapshot[],
  entry: ClosedEditorTabSnapshot
): ClosedEditorTabSnapshot[] {
  // Why: higher closeOrder is more recent and stays in front. A missing stamp is older than any stamped close.
  const order = entry.closeOrder ?? Number.MAX_SAFE_INTEGER
  const index = stack.findIndex((item) => (item.closeOrder ?? -1) < order)
  const placed =
    index === -1 ? [...stack, entry] : [...stack.slice(0, index), entry, ...stack.slice(index)]
  return placed.slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
}

export function rememberKeptUntitledEditor(
  set: EditorSet,
  file: OpenFile,
  position: RecentlyClosedTabPosition | undefined,
  closeOrder: number
): void {
  if (!file.worktreeId || file.mode === 'markdown-preview') {
    return
  }
  const { id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snap } = file
  set((state) => {
    // The stat can outlive the worktree. Writing the captured id after removal
    // or rename puts history on a key that can no longer reopen.
    if (!findWorktreeById(state.worktreesByRepo, file.worktreeId)) {
      return state
    }
    const stack = state.recentlyClosedEditorTabsByWorktree[file.worktreeId] ?? []
    if (stack.some((entry) => entry.reopenId === id)) {
      return state
    }
    return {
      recentlyClosedEditorTabsByWorktree: {
        ...state.recentlyClosedEditorTabsByWorktree,
        [file.worktreeId]: placeClosedEditorSnapshot(stack, {
          ...(snap as ClosedEditorTabSnapshot),
          reopenId: id,
          closeOrder,
          ...(position ? { position } : {})
        })
      },
      recentlyClosedTabKindsByWorktree: insertRecentlyClosedTabKind(
        state.recentlyClosedTabKindsByWorktree,
        file.worktreeId,
        'editor',
        closeOrder
      )
    }
  })
}

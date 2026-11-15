import { useEffect, useMemo } from 'react'
import { useAppStore } from '@/store'
import type { WorktreePurgeTarget } from '@/store/slices/worktrees/teardown/worktree-purge-target'
import { worktreePurgeClosedFileIds } from '@/store/slices/worktrees/teardown/worktree-purge-closed-files'
import {
  flushRemovalPendingEdits,
  lastViewUnsavedFiles
} from '@/components/editor/save/flush/removal-unsaved-editor-files'
import { runAfterEditorFramesFlush } from '@/components/editor/save/flush/editor-pending-flush'

/** Unsaved editor files a removal would discard. Memoize targets so the set stays stable. */
export function useRemovalUnsavedFiles(
  targets: readonly WorktreePurgeTarget[],
  enabled: boolean
): ReturnType<typeof lastViewUnsavedFiles> {
  const openFiles = useAppStore((s) => (enabled ? s.openFiles : null))
  const editorDrafts = useAppStore((s) => (enabled ? s.editorDrafts : null))

  useEffect(() => {
    if (enabled) {
      // Flush delayed typing so this list includes the latest unsaved drafts.
      const state = useAppStore.getState()
      const fileIds = worktreePurgeClosedFileIds(state, targets)
      flushRemovalPendingEdits(state, fileIds)
      // Custom editor frames answer asynchronously; the list re-renders when their edits land.
      runAfterEditorFramesFlush(state, fileIds, () => {})
    }
  }, [enabled, targets])

  return useMemo(() => {
    if (!openFiles || !editorDrafts) {
      return []
    }
    const state = { ...useAppStore.getState(), openFiles, editorDrafts }
    return lastViewUnsavedFiles(state, worktreePurgeClosedFileIds(state, targets))
  }, [editorDrafts, openFiles, targets])
}

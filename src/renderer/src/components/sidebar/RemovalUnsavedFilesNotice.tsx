import { useEffect, useMemo, type JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import { useAppStore } from '@/store'
import type { WorktreePurgeTarget } from '@/store/slices/worktree-helpers'
import { worktreePurgeClosedFileIds } from '@/store/slices/worktrees/teardown/worktree-purge-closed-files'
import {
  flushRemovalPendingEdits,
  lastViewUnsavedFiles
} from '@/components/editor/removal-unsaved-editor-files'
import { discardedUnsavedFilesLabel, moreUnsavedFilesLabel } from './removal-unsaved-files'

const MAX_LISTED_FILES = 5

/** Lists editor files whose unsaved edits a removal of `targets` (memoized) would discard. */
export function RemovalUnsavedFilesNotice({
  targets,
  enabled
}: {
  targets: readonly WorktreePurgeTarget[]
  enabled: boolean
}): JSX.Element | null {
  const openFiles = useAppStore((s) => (enabled ? s.openFiles : null))
  const editorDrafts = useAppStore((s) => (enabled ? s.editorDrafts : null))

  useEffect(() => {
    if (enabled) {
      // Why: delayed views hold recent typing; the flushed drafts re-run the list below.
      const state = useAppStore.getState()
      flushRemovalPendingEdits(state, worktreePurgeClosedFileIds(state, targets))
    }
  }, [enabled, targets])

  const files = useMemo(() => {
    if (!openFiles || !editorDrafts) {
      return []
    }
    const state = { ...useAppStore.getState(), openFiles, editorDrafts }
    return lastViewUnsavedFiles(state, worktreePurgeClosedFileIds(state, targets))
  }, [editorDrafts, openFiles, targets])

  if (files.length === 0) {
    return null
  }
  const hidden = files.length - MAX_LISTED_FILES
  return (
    <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
        <div className="min-w-0 flex-1">
          {discardedUnsavedFilesLabel(files.length)}
          <ul className="mt-1 min-w-0 space-y-0.5">
            {files.slice(0, MAX_LISTED_FILES).map((file) => (
              <li key={file.id} className="truncate text-foreground" title={file.filePath}>
                {file.relativePath || file.filePath}
              </li>
            ))}
            {hidden > 0 && <li>{moreUnsavedFilesLabel(hidden)}</li>}
          </ul>
        </div>
      </div>
    </div>
  )
}

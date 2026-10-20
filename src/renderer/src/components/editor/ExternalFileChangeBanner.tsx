import React, { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import { ExternalFileChangeCompareDialog } from './ExternalFileChangeCompareDialog'
import { getDiskBaselineSignature } from './diff-content-signature'
import { trackExternalChangeConflictAction } from './editor-external-change-telemetry'
import { attemptEditorFileSave } from './editor-file-save-attempt'
import {
  editorModelDraftHolder,
  editorModelSiblingTabs,
  isEditorBaselineRestampSuperseded,
  isEditorModelDirty,
  setEditorDiskBaseline,
  trackEditorBaselineRestamp
} from './editor-save-disk-precondition'
import { setModelExternalMutation } from './editor-save-rebaseline'
import { notifyEditorFileCacheStale } from './editor-autosave'

// Why: when an external process (usually an agent) rewrites a file while the
// tab holds unsaved edits, the reload pipeline preserves the buffer and marks
// the tab externalMutation='changed' (issue #7265). This banner is the
// recovery path — without it the tab is silently stale until close/reopen and
// the next save clobbers the newer disk content unannounced.

const RELOAD_UNDO_TOAST_DURATION_MS = 8_000

export function reloadTabContentFromDisk(
  file: OpenFile,
  reloadContent: (file: OpenFile) => void
): void {
  const state = useAppStore.getState()
  const liveTab = state.openFiles.find((openFile) => openFile.id === file.id)
  // Why holder: a clean tab's Reload discards the unsaved text a sibling of the model holds.
  const holder = liveTab ? editorModelDraftHolder(state, liveTab) : undefined
  const discardedDraft = state.editorDrafts[holder?.id ?? file.id]
  const discardedDiskSignature = liveTab?.lastKnownDiskSignature
  // Why: drop the draft before reloading — the buffer shadows loaded content
  // (editBuffers ?? fileContents), so a reload alone would keep showing the
  // stale unsaved text.
  // Why every sibling: they share the model a reload replaces, so their drafts go with it.
  const siblings = liveTab ? editorModelSiblingTabs(state, liveTab) : [file]
  for (const tab of siblings) {
    state.clearEditorDraft(tab.id)
    state.markFileDirty(tab.id, false)
    state.setExternalMutation(tab.id, null)
    reloadContent(tab)
  }
  if (discardedDraft === undefined) {
    return
  }
  // Why: on diff tabs the reload rotates the Monaco model, destroying the undo
  // stack — without this toast a mistaken click is an unrecoverable discard.
  toast(
    translate('auto.components.editor.ExternalFileChangeBanner.5c02de9b31', 'Reloaded from disk'),
    {
      description: file.relativePath,
      duration: RELOAD_UNDO_TOAST_DURATION_MS,
      action: {
        label: translate('auto.components.editor.ExternalFileChangeBanner.d1e830fa22', 'Undo'),
        onClick: () => {
          const current = useAppStore.getState()
          const liveFile = current.openFiles.find((openFile) => openFile.id === file.id)
          // Why: the tab may have closed while the toast was up; restoring a
          // draft for a dead fileId would strand an orphan buffer. And if the
          // user already typed after the reload (dirty), that newer work wins
          // — undoing over it would be a second silent discard. isDirty is the
          // signal: the editor content-sync repopulates editorDrafts with the
          // reloaded content itself, so draft existence proves nothing.
          // Why every sibling: they share the reloaded text, so typing in any of them is newer work.
          // Why re-read: a tab that joined the model since the reload (another workspace) counts too.
          const modelTabs = liveFile ? editorModelSiblingTabs(current, liveFile) : []
          if (!liveFile || modelTabs.some((tab) => tab.isDirty)) {
            return
          }
          // Why: a reloaded tab that has since left the model holds its own text; leave it alone.
          const liveSiblings = modelTabs.filter((tab) =>
            siblings.some((reloaded) => reloaded.id === tab.id)
          )
          if (discardedDiskSignature !== undefined) {
            // Why: the reload re-stamped the baseline to the new disk content;
            // restoring the pre-reload signature with the draft keeps the
            // restart scan re-deriving the conflict the undo just brought back.
            setEditorDiskBaseline(current, file.id, discardedDiskSignature)
          }
          for (const tab of liveSiblings) {
            current.setEditorDraft(tab.id, discardedDraft)
            current.markFileDirty(tab.id, true)
            // Why: the disk still differs from the restored draft, so the
            // conflict (and its autosave suspension) must come back with it.
            current.setExternalMutation(tab.id, 'changed')
          }
          trackExternalChangeConflictAction(file, 'undo_reload')
        }
      }
    }
  )
}

export function keepTabEditsOverExternalChange(file: OpenFile): void {
  const state = useAppStore.getState()
  // Why model-wide: a sibling left marked would keep its banner and suspended autosave if the read fails.
  setModelExternalMutation(state, file.id, null)
  // Why: the dismissal must survive restart — without advancing the baseline
  // to the current disk content, the restored-tab conflict scan re-derives
  // the dismissed conflict from the stale signature on every launch.
  // Best-effort: a failed read leaves the old signature, which can only
  // re-surface the banner — never lose data.
  const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  if (!target) {
    return
  }
  // Why tracked: a save right after Keep must compare against the disk the user chose to overwrite.
  const restamp = readRuntimeFileContent({
    target,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
    expectedExternalSshTargetId: file.externalSshTargetId,
    access: editorTabFileAccess(state, file)
  }).then((result) => {
    if (result.isBinary) {
      return
    }
    const current = useAppStore.getState()
    const liveFile = current.openFiles.find((openFile) => openFile.id === file.id)
    // Why: only stamp while the dismissal still stands — a save or a newer
    // conflict marked in the interim owns the baseline.
    // A save that finished after this read started already set a newer baseline.
    if (
      !liveFile ||
      liveFile.externalMutation === 'changed' ||
      isEditorBaselineRestampSuperseded(file.id)
    ) {
      return
    }
    // Why: the model's one baseline moves; siblings show the same model, which holds the kept text.
    const moved = setEditorDiskBaseline(current, file.id, getDiskBaselineSignature(result.content))
    // Why: a dirty model holds the kept text; a revealed sibling must show it, not reload disk.
    const modelDirty = isEditorModelDirty(current, liveFile)
    for (const tab of moved) {
      current.setExternalMutation(tab.id, null)
      if (!modelDirty && current.editorDrafts[tab.id] === undefined) {
        notifyEditorFileCacheStale(tab.id)
      }
    }
  })
  trackEditorBaselineRestamp(file.id, restamp)
}

/** The banner's Overwrite: the one explicit consent to replace the newer disk content. */
export function overwriteDiskWithTabEdits(file: OpenFile): Promise<boolean> {
  const state = useAppStore.getState()
  const live = state.openFiles.find((openFile) => openFile.id === file.id)
  // Why: the unsaved text may live in another tab of the same model; with none there is nothing to write.
  const holder = live ? editorModelDraftHolder(state, live) : undefined
  return holder
    ? attemptEditorFileSave({ fileId: holder.id, overwrite: true })
    : Promise.resolve(false)
}

export function ExternalFileChangeBanner({
  file,
  currentContent,
  reloadContent
}: {
  file: OpenFile
  /** The tab's live buffer (draft if dirty) — what "Keep My Edits" keeps. */
  currentContent: string
  /** Refetches the tab's content — file body for edit tabs, diff body for
   *  unstaged diff tabs. */
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const [compareOpen, setCompareOpen] = useState(false)
  // Why model-level: another tab of the same code model may hold the unsaved text.
  const isModelDirty = useAppStore((state) => {
    const live = state.openFiles.find((openFile) => openFile.id === file.id)
    return live ? isEditorModelDirty(state, live) : file.isDirty
  })
  const modelDraft = useAppStore((state) => {
    const live = state.openFiles.find((openFile) => openFile.id === file.id)
    const holder = live ? editorModelDraftHolder(state, live) : undefined
    return holder ? state.editorDrafts[holder.id] : undefined
  })

  const handleReload = (): void => {
    trackExternalChangeConflictAction(file, 'reload')
    reloadTabContentFromDisk(file, reloadContent)
  }
  const handleKeepEdits = (): void => {
    trackExternalChangeConflictAction(file, 'keep')
    keepTabEditsOverExternalChange(file)
  }
  const handleOverwrite = (): void => {
    void overwriteDiskWithTabEdits(file)
  }
  const handleCompare = (): void => {
    trackExternalChangeConflictAction(file, 'compare')
    setCompareOpen(true)
  }

  return (
    // Why: role=alert because the banner appears asynchronously (an agent
    // rewrote the file) — screen readers must announce it unprompted.
    <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          {/* Why: wraps instead of truncating — the overwrite warning at the
              end of the sentence is the part the user must not lose. */}
          <span className="min-w-0 font-medium text-foreground">
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.7c41e90d12',
              'This file changed on disk while you have unsaved edits. Overwrite replaces the newer disk content.'
            )}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" size="xs" variant="outline" onClick={handleCompare}>
            {translate('auto.components.editor.ExternalFileChangeBanner.90b2ce7d43', 'Compare')}
          </Button>
          <Button type="button" size="xs" variant="outline" onClick={handleReload}>
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.3fa2b8d417',
              'Reload from Disk'
            )}
          </Button>
          {/* Why: with no unsaved edits there is nothing to write over the newer disk version. */}
          {isModelDirty && (
            <Button type="button" size="xs" variant="outline" onClick={handleOverwrite}>
              {translate('auto.components.editor.ExternalFileChangeBanner.overwrite', 'Overwrite')}
            </Button>
          )}
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={handleKeepEdits}
            title={translate(
              'auto.components.editor.ExternalFileChangeBanner.keepHint',
              'Keeps your version. Your next save replaces the version on disk.'
            )}
          >
            {translate(
              'auto.components.editor.ExternalFileChangeBanner.a95d02c644',
              'Keep My Edits'
            )}
          </Button>
        </div>
      </div>
      {compareOpen && (
        <ExternalFileChangeCompareDialog
          file={file}
          currentContent={modelDraft ?? currentContent}
          open={compareOpen}
          onOpenChange={setCompareOpen}
          onReload={handleReload}
          onKeepEdits={handleKeepEdits}
        />
      )}
    </div>
  )
}

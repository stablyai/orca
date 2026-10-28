import React, { useState } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import { ExternalFileChangeCompareDialog } from './ExternalFileChangeCompareDialog'
import { getDiskBaselineSignature } from '../../../../shared/disk-baseline-signature'
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
import { reloadEditorFileFromDisk } from './editor-disk-reload'
import { offerReloadUndo } from './editor-disk-reload-undo'

// External writes preserve unsaved drafts and mark a conflict; expose recovery before a later save can overwrite the newer disk content.

export function reloadTabContentFromDisk(
  file: OpenFile,
  reloadContent: (file: OpenFile) => void
): Promise<void> {
  if (file.mode === 'edit') {
    return reloadEditorFileFromDisk(file.id, {
      onUndo: () => trackExternalChangeConflictAction(file, 'undo_reload')
    })
  }
  const state = useAppStore.getState()
  const liveTab = state.openFiles.find((openFile) => openFile.id === file.id)
  // A clean tab may share a model whose unsaved draft belongs to a sibling.
  const holder = liveTab ? editorModelDraftHolder(state, liveTab) : undefined
  const discardedDraft = state.editorDrafts[holder?.id ?? file.id]
  const discardedDiskSignature = liveTab?.lastKnownDiskSignature
  // Clear every model sibling’s draft before reload because drafts shadow loaded content.
  const siblings = liveTab ? editorModelSiblingTabs(state, liveTab) : [file]
  for (const tab of siblings) {
    state.clearEditorDraft(tab.id)
    state.markFileDirty(tab.id, false)
    state.setExternalMutation(tab.id, null)
    reloadContent(tab)
  }
  if (discardedDraft !== undefined) {
    offerReloadUndo({
      file,
      draft: discardedDraft,
      viewIds: siblings.map((tab) => tab.id),
      baseline: discardedDiskSignature,
      // Restored edits still differ from disk, so restore the conflict and autosave suspension too.
      restoredMutation: 'changed',
      onUndo: () => trackExternalChangeConflictAction(file, 'undo_reload')
    })
  }
  return Promise.resolve()
}

export function keepTabEditsOverExternalChange(file: OpenFile): void {
  const state = useAppStore.getState()
  // Clear model-wide or siblings would retain banners and suspended autosave when the read fails.
  setModelExternalMutation(state, file.id, null)
  // Advance the disk baseline so dismissal survives restart; a failed read safely leaves the banner eligible to return.
  const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  if (!target) {
    return
  }
  // Track the read so an immediate save compares against the disk the user chose to overwrite.
  const restamp = readRuntimeFileContent({
    target,
    filePath: file.filePath,
    relativePath: file.relativePath,
    worktreeId: file.worktreeId,
    connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
    expectedExternalSshTargetId: file.externalSshTargetId,
    access: editorTabFileAccess(state, file),
    terminalArtifactGrantId: file.terminalArtifactGrantId
  }).then((result) => {
    if (result.isBinary) {
      return
    }
    const current = useAppStore.getState()
    const liveFile = current.openFiles.find((openFile) => openFile.id === file.id)
    // Only stamp if dismissal still stands; newer conflicts and completed saves own the baseline.
    if (
      !liveFile ||
      liveFile.externalMutation === 'changed' ||
      isEditorBaselineRestampSuperseded(file.id)
    ) {
      return
    }
    // Move the shared model baseline once for all sibling views.
    const moved = setEditorDiskBaseline(current, file.id, getDiskBaselineSignature(result.content))
    // Dirty siblings share the kept text; revealing them must not reload disk.
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
  // Find the model’s draft holder, which may be another tab; without one there is nothing to overwrite.
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
  /** Refetch file content for edit tabs or diff content for unstaged tabs. */
  reloadContent: (file: OpenFile) => void
}): React.JSX.Element {
  const [compareOpen, setCompareOpen] = useState(false)
  // A sibling of this code model may own its unsaved text.
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
    void reloadTabContentFromDisk(file, reloadContent)
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
    // Announce asynchronous external-write conflicts to screen readers.
    <div role="alert" className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <TriangleAlert className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
          {/* Wrap the overwrite warning so truncation cannot hide it. */}
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
          {/* Only unsaved model edits can overwrite newer disk content. */}
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

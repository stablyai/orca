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

// External writes preserve unsaved drafts and mark a conflict; expose recovery before a later save can overwrite the newer disk content.

const RELOAD_UNDO_TOAST_DURATION_MS = 8_000

export function reloadTabContentFromDisk(
  file: OpenFile,
  reloadContent: (file: OpenFile) => void
): void {
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
  if (discardedDraft === undefined) {
    return
  }
  // Diff reloads destroy model undo history; retain recovery in this toast.
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
          // Undo only for live, clean model siblings, including tabs added since reload. isDirty proves newer work; content sync also populates drafts for clean tabs.
          const modelTabs = liveFile ? editorModelSiblingTabs(current, liveFile) : []
          if (!liveFile || modelTabs.some((tab) => tab.isDirty)) {
            return
          }
          // Tabs that left the model now own independent text and must remain untouched.
          const liveSiblings = modelTabs.filter((tab) =>
            siblings.some((reloaded) => reloaded.id === tab.id)
          )
          if (discardedDiskSignature !== undefined) {
            // Restore the old disk signature so restart scans preserve the conflict alongside the recovered draft.
            setEditorDiskBaseline(current, file.id, discardedDiskSignature)
          }
          for (const tab of liveSiblings) {
            current.setEditorDraft(tab.id, discardedDraft)
            current.markFileDirty(tab.id, true)
            // Restored edits still differ from disk, so restore the conflict and autosave suspension too.
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

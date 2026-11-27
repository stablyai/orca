import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import type { ClosedUnsavedFile } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { getEditorFileOperationContext } from '@/lib/editor/file-operations/editor-file-operation-owner'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance
} from '@/lib/editor/file-operations/editor-file-operation-provenance'
import { createUntitledMarkdownFile } from '@/lib/editor/file-operations/create-untitled-markdown'
import { translate } from '@/i18n/i18n'
import { getDiskBaselineSignature } from '../../../../../../shared/file-write/disk-baseline-signature'
import {
  recordSelfWrite,
  SELF_WRITE_REMOTE_TTL_MS
} from '../../external-changes/editor-self-write-registry'

function closedUnsavedFilesToastTitle(count: number, workspace: string): string {
  return translate(
    'components.workspace.delete.unsavedEdits.closedToast',
    'Closed {{count}} files with unsaved edits from {{workspace}}',
    {
      count,
      workspace,
      defaultValue_one: 'Closed {{count}} file with unsaved edits from {{workspace}}'
    }
  )
}

/** Recovery creates new files only in the active workspace, never at the removed paths; `asDirtyDrafts` keeps the text unsaved in an empty untitled file. */
export async function reopenClosedUnsavedFiles(
  closed: readonly ClosedUnsavedFile[],
  { asDirtyDrafts = false }: { asDirtyDrafts?: boolean } = {}
): Promise<ClosedUnsavedFile[]> {
  const failed: ClosedUnsavedFile[] = []
  for (const file of closed) {
    try {
      const state = useAppStore.getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        throw new Error('No active workspace')
      }
      const operationProvenance = captureEditorFileOperationProvenance(
        state,
        worktreeId,
        undefined,
        false
      )
      // Use provenance ownership so a same-ID workspace on another host cannot supply the recovery path.
      const ownerHostId = operationProvenance.generation.route.executionHostId
      const activeHostId = state.activeWorkspaceExecutionHostId
      const worktree = state.getKnownWorktreeById(
        worktreeId,
        ownerHostId ?? activeHostId ?? undefined
      )
      if (!worktree || (ownerHostId && activeHostId && activeHostId !== ownerHostId)) {
        throw new Error('Active workspace owner is ambiguous')
      }
      const context = getEditorFileOperationContext(
        state,
        { worktreeId, operationProvenance },
        worktree.path
      )
      const fileInfo = await createUntitledMarkdownFile(
        worktree.path,
        worktreeId,
        context.connectionId,
        context.target,
        {
          recoveredDocument: asDirtyDrafts
            ? { originalPath: file.filePath }
            : { originalPath: file.filePath, content: file.content },
          operationProvenance,
          expectedSshConnectionGeneration: context.expectedSshConnectionGeneration,
          expectedSshTargetId: context.expectedSshTargetId,
          expectedExecutionHostId: context.expectedExecutionHostId,
          assertOperationCurrent: () =>
            assertEditorFileOperationCurrent(
              useAppStore.getState(),
              worktreeId,
              operationProvenance
            )
        }
      )
      const store = useAppStore.getState()
      const fileId = store.openFile(fileInfo, { preview: false, focusEditor: !asDirtyDrafts })
      if (asDirtyDrafts) {
        const runtimeEnvironmentId = useAppStore
          .getState()
          .openFiles.find((open) => open.id === fileId)?.runtimeEnvironmentId
        // Why: our own create's watcher echo would otherwise flag the dirty tab as changed on disk.
        recordSelfWrite(fileInfo.filePath, '', runtimeEnvironmentId, SELF_WRITE_REMOTE_TTL_MS)
        // Why: this create made the file empty; without that baseline every save is refused as stale.
        store.setLastKnownDiskSignature(fileId, getDiskBaselineSignature(''))
        store.setEditorDraft(fileId, file.content)
        store.markFileDirty(fileId, true)
      }
    } catch (error) {
      failed.push(file)
      console.warn('[editor] could not reopen closed unsaved file', {
        filePath: file.filePath,
        error
      })
    }
  }
  if (failed.length > 0 && !asDirtyDrafts) {
    toast.error(
      translate(
        'components.workspace.delete.unsavedEdits.reopenFailed',
        "Some files couldn't be reopened. Open a workspace and try Reopen again."
      )
    )
  }
  return failed
}

/** Toast callbacks retain a clearable holder; dismissal releases kept records and recovered text. */
export function showClosedUnsavedFilesToast(
  closed: readonly ClosedUnsavedFile[],
  workspaceLabel: string,
  notice: number
): void {
  const holder: { files: readonly ClosedUnsavedFile[] | null } = { files: closed }
  let reopening = false
  const toastId = toast.warning(closedUnsavedFilesToastTitle(closed.length, workspaceLabel), {
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: translate('components.workspace.delete.unsavedEdits.reopen', 'Reopen'),
      onClick: (event) => {
        event.preventDefault()
        if (reopening || !holder.files) {
          return
        }
        reopening = true
        void reopenClosedUnsavedFiles(holder.files).then((failed) => {
          reopening = false
          // Dismiss can release the holder while creation is still in flight.
          if (!holder.files) {
            return
          }
          holder.files = failed.length > 0 ? failed : null
          if (!holder.files) {
            toast.dismiss(toastId)
          }
        })
      }
    },
    onDismiss: () => {
      const files = holder.files
      holder.files = null
      useAppStore.getState().releaseKeptEditorBuffers(notice)
      if (files) {
        console.warn('[editor] dropped unsaved edits from a removed workspace', {
          filePaths: files.map((file) => file.filePath)
        })
      }
    }
  })
}

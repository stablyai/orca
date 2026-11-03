import React, { useCallback, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { dirname } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from '@/lib/editor-file-operation-owner'
import {
  createNamedFile,
  isSshOwnedFileContext,
  NamedFileExistsError,
  suggestUntitledName
} from '@/lib/create-named-file'
import { useMountedRef } from '@/hooks/useMountedRef'
import { NewFileDialog } from './NewFileDialog'

/** Mounted while activeModal is 'new-file'; creates the file on the active workspace's own host. */
export default function NewFileModal(): React.JSX.Element | null {
  const worktreeId = useAppStore((s) => s.activeWorktreeId)
  const worktreePath = useAppStore((s) =>
    s.activeWorktreeId ? (s.getKnownWorktreeById(s.activeWorktreeId)?.path ?? null) : null
  )
  const activeFilePath = useAppStore((s) => {
    const fileId = s.activeWorktreeId ? s.activeFileIdByWorktree[s.activeWorktreeId] : null
    const file = fileId ? s.openFiles.find((f) => f.id === fileId) : undefined
    return file && file.worktreeId === s.activeWorktreeId && file.mode === 'edit'
      ? file.filePath
      : null
  })
  const closeModal = useAppStore((s) => s.closeModal)
  const mountedRef = useMountedRef()

  // Why: pinned at open so a worktree switch behind the dialog cannot redirect the write.
  const opened = useMemo(() => {
    if (!worktreeId || !worktreePath) {
      return null
    }
    const state = useAppStore.getState()
    const operationProvenance = captureEditorFileOperationProvenance(
      state,
      worktreeId,
      undefined,
      false
    )
    let disableBrowse = true
    let sshOwned = false
    try {
      const context = getEditorFileOperationContext(
        state,
        { worktreeId, operationProvenance },
        worktreePath
      )
      disableBrowse = context.target.kind !== 'local' || Boolean(context.connectionId)
      sshOwned = isSshOwnedFileContext(context)
    } catch {
      // Unresolved owner: keep the local folder picker off; create will surface the owner error.
    }
    return { worktreeId, worktreePath, operationProvenance, disableBrowse, sshOwned }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot once per mount
  }, [])

  const sshBlocked = opened?.sshOwned === true
  useEffect(() => {
    if (!sshBlocked) {
      return
    }
    // Why: a fixed id collapses the duplicate effect run React StrictMode performs in development.
    toast.error(
      translate(
        'auto.components.editor.NewFileDialog.sshUnsupported',
        "Creating files in SSH workspaces isn't supported yet."
      ),
      { id: 'new-file-ssh-unsupported' }
    )
    closeModal()
  }, [closeModal, sshBlocked])

  const handleCreate = useCallback(
    async ({ name, folder }: { name: string; folder: string }): Promise<string | null> => {
      if (!opened) {
        return null
      }
      const state = useAppStore.getState()
      try {
        const context = getEditorFileOperationContext(
          state,
          { worktreeId: opened.worktreeId, operationProvenance: opened.operationProvenance },
          opened.worktreePath
        )
        const info = await createNamedFile(
          { ...context, worktreePath: opened.worktreePath },
          folder,
          name,
          () => {
            // Why: Cancel before the write lands must stop it; after it, nothing may open or close.
            if (!mountedRef.current) {
              throw new Error('New file dialog closed')
            }
            assertEditorFileOperationCurrent(
              useAppStore.getState(),
              opened.worktreeId,
              opened.operationProvenance
            )
          }
        )
        if (!mountedRef.current) {
          return null
        }
        const latest = useAppStore.getState()
        latest.openFile(info, {
          preview: false,
          targetGroupId: latest.activeGroupIdByWorktree[opened.worktreeId],
          focusEditor: true
        })
        closeModal()
        return null
      } catch (err) {
        if (err instanceof NamedFileExistsError) {
          return translate(
            'auto.components.editor.NewFileDialog.nameTaken',
            'A file with that name already exists'
          )
        }
        return extractIpcErrorMessage(
          err,
          translate(
            'auto.components.editor.NewFileDialog.createFailed',
            "Couldn't create the file."
          )
        )
      }
    },
    [closeModal, mountedRef, opened]
  )

  const suggestName = useCallback(
    async (folder: string): Promise<string | null> => {
      if (!opened || !folder) {
        return null
      }
      try {
        const state = useAppStore.getState()
        const context = getEditorFileOperationContext(
          state,
          { worktreeId: opened.worktreeId, operationProvenance: opened.operationProvenance },
          opened.worktreePath
        )
        return await suggestUntitledName(
          { ...context, worktreePath: opened.worktreePath },
          folder,
          () =>
            assertEditorFileOperationCurrent(
              useAppStore.getState(),
              opened.worktreeId,
              opened.operationProvenance
            )
        )
      } catch {
        // Why: the placeholder is advisory; create reports real owner or filesystem errors.
        return null
      }
    },
    [opened]
  )

  if (!opened || sshBlocked) {
    return null
  }

  return (
    <NewFileDialog
      worktreePath={opened.worktreePath}
      defaultFolder={activeFilePath ? dirname(activeFilePath) : opened.worktreePath}
      disableBrowse={opened.disableBrowse}
      suggestName={suggestName}
      onCreate={handleCreate}
      onClose={closeModal}
    />
  )
}

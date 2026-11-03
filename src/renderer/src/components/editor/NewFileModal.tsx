import React, { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { dirname } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from '@/lib/editor-file-operation-owner'
import { createNamedFile, NamedFileExistsError, suggestUntitledName } from '@/lib/create-named-file'
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
    try {
      const context = getEditorFileOperationContext(
        state,
        { worktreeId, operationProvenance },
        worktreePath
      )
      disableBrowse = context.target.kind !== 'local' || Boolean(context.connectionId)
    } catch {
      // Unresolved owner: keep the local folder picker off; create will surface the owner error.
    }
    return { worktreeId, worktreePath, operationProvenance, disableBrowse }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot once per mount
  }, [])

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
          () =>
            assertEditorFileOperationCurrent(
              useAppStore.getState(),
              opened.worktreeId,
              opened.operationProvenance
            )
        )
        const groupId = state.activeGroupIdByWorktree[opened.worktreeId]
        useAppStore
          .getState()
          .openFile(info, { preview: false, targetGroupId: groupId, focusEditor: true })
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
    [closeModal, opened]
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

  if (!opened) {
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

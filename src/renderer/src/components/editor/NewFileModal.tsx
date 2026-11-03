import React, { useCallback, useEffect, useMemo } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { dirname } from '@/lib/path'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext,
  type EditorFileOperationProvenance
} from '@/lib/editor-file-operation-owner'
import {
  createNamedFile,
  isSshOwnedFileContext,
  NamedFileExistsError,
  NamedFileOutsideWorkspaceError,
  suggestUntitledName
} from '@/lib/create-named-file'
import { useMountedRef } from '@/hooks/useMountedRef'
import { NewFileDialog } from './NewFileDialog'

type OpenedSession = {
  worktreeId: string
  worktreePath: string
  operationProvenance: EditorFileOperationProvenance
  disableBrowse: boolean
}

type OpenResult =
  | { session: OpenedSession; blockedMessage: null }
  | { session: null; blockedMessage: string }

const BLOCKED_TOAST_ID = 'new-file-blocked'

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
  const opened = useMemo((): OpenResult | null => {
    if (!worktreeId || !worktreePath) {
      return null
    }
    const state = useAppStore.getState()
    try {
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
        if (isSshOwnedFileContext(context)) {
          return {
            session: null,
            blockedMessage: translate(
              'auto.components.editor.NewFileDialog.sshUnsupported',
              "Creating files in SSH workspaces isn't supported yet."
            )
          }
        }
        disableBrowse = context.target.kind !== 'local' || Boolean(context.connectionId)
      } catch {
        // Unresolved owner: keep the local folder picker off; create will surface the owner error.
      }
      return {
        session: { worktreeId, worktreePath, operationProvenance, disableBrowse },
        blockedMessage: null
      }
    } catch (err) {
      return {
        session: null,
        blockedMessage: extractIpcErrorMessage(
          err,
          translate(
            'auto.components.editor.NewFileDialog.createFailed',
            "Couldn't create the file."
          )
        )
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot once per mount
  }, [])

  const session = opened?.session ?? null
  const blockedMessage = opened?.blockedMessage ?? null
  useEffect(() => {
    if (!blockedMessage) {
      return
    }
    // Why: a fixed id collapses the duplicate effect run React StrictMode performs in development.
    toast.error(blockedMessage, { id: BLOCKED_TOAST_ID })
    closeModal()
  }, [blockedMessage, closeModal])

  const handleCreate = useCallback(
    async ({ name, folder }: { name: string; folder: string }): Promise<string | null> => {
      if (!session) {
        return null
      }
      try {
        const context = getEditorFileOperationContext(
          useAppStore.getState(),
          { worktreeId: session.worktreeId, operationProvenance: session.operationProvenance },
          session.worktreePath
        )
        const info = await createNamedFile(
          { ...context, worktreePath: session.worktreePath },
          folder,
          name,
          () => {
            // Why: stops a create that has not been dispatched yet once the dialog is gone; a write already sent cannot be recalled.
            if (!mountedRef.current) {
              throw new Error('New file dialog closed')
            }
            assertEditorFileOperationCurrent(
              useAppStore.getState(),
              session.worktreeId,
              session.operationProvenance
            )
          }
        )
        if (!mountedRef.current) {
          return null
        }
        const latest = useAppStore.getState()
        latest.openFile(info, {
          preview: false,
          targetGroupId: latest.activeGroupIdByWorktree[session.worktreeId],
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
        if (err instanceof NamedFileOutsideWorkspaceError) {
          return translate(
            'auto.components.editor.NewFileDialog.folderOutsideWorkspace',
            'Folder must be inside the current workspace'
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
    [closeModal, mountedRef, session]
  )

  const suggestName = useCallback(
    async (folder: string): Promise<string | null> => {
      if (!session || !folder) {
        return null
      }
      try {
        const context = getEditorFileOperationContext(
          useAppStore.getState(),
          { worktreeId: session.worktreeId, operationProvenance: session.operationProvenance },
          session.worktreePath
        )
        return await suggestUntitledName(
          { ...context, worktreePath: session.worktreePath },
          folder,
          () =>
            assertEditorFileOperationCurrent(
              useAppStore.getState(),
              session.worktreeId,
              session.operationProvenance
            )
        )
      } catch {
        // Why: the placeholder is advisory; create reports real owner or filesystem errors.
        return null
      }
    },
    [session]
  )

  if (!session) {
    return null
  }

  return (
    <NewFileDialog
      worktreePath={session.worktreePath}
      defaultFolder={activeFilePath ? dirname(activeFilePath) : session.worktreePath}
      disableBrowse={session.disableBrowse}
      suggestName={suggestName}
      onCreate={handleCreate}
      onClose={closeModal}
    />
  )
}

import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { dirname, basename } from '@/lib/path'
import { useAppStore } from '@/store'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost
} from '@/lib/worktree-runtime-owner-index'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'

export type RichMarkdownImageInsertArgs = {
  editor: Editor
  fileId: string
  filePath: string
  sourcePath: string
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
  insertPos: number
  canInsert?: (editor: Editor) => boolean
}

export async function insertRichMarkdownImageFromPath({
  editor,
  fileId,
  filePath,
  sourcePath,
  worktreeId,
  runtimeEnvironmentId,
  insertPos,
  canInsert
}: RichMarkdownImageInsertArgs): Promise<void> {
  try {
    const state = useAppStore.getState()
    const liveFile = state.openFiles.find(
      (file) => file.id === fileId && file.worktreeId === worktreeId
    )
    if (worktreeId && !liveFile) {
      throw new Error("Couldn't verify which host owns this file. Reopen the file and try again.")
    }
    const ownerHostId = parseExecutionHostId(
      liveFile?.operationProvenance?.generation.route.executionHostId ??
        liveFile?.workspaceExecutionHostId
    )?.id
    const worktreePath = getWorktreePath(state, worktreeId, ownerHostId)
    const fileContext =
      worktreeId && liveFile
        ? getEditorFileOperationContext(state, liveFile, worktreePath)
        : {
            settings: settingsForRuntimeOwner(state.settings, runtimeEnvironmentId),
            worktreeId,
            worktreePath,
            expectedExecutionHostId: 'local' as const
          }
    const settings = fileContext.settings
    if (settings?.activeRuntimeEnvironmentId?.trim() && !fileContext.worktreePath) {
      toast.error(
        translate(
          'auto.components.editor.useLocalImagePick.91d835dc88',
          'Worktree path not available.'
        )
      )
      return
    }

    // Why: image bytes should live beside the note instead of inside markdown;
    // this keeps rich-mode size checks based on document text, not binary data.
    const { results } = await importExternalPathsToRuntime(
      fileContext,
      [sourcePath],
      dirname(filePath)
    )
    const imported = results.find((result) => result.status === 'imported')
    if (!imported) {
      toast.error(
        translate('auto.components.editor.useLocalImagePick.175cb8b8ce', 'Failed to insert image.')
      )
      return
    }

    if (canInsert && !canInsert(editor)) {
      return
    }

    const imageSrc = encodeMarkdownImageBasename(imported.destPath)
    const inserted = editor
      .chain()
      .focus()
      .insertContentAt(insertPos, { type: 'image', attrs: { src: imageSrc } })
      .run()
    if (!inserted) {
      toast.error(
        translate('auto.components.editor.useLocalImagePick.175cb8b8ce', 'Failed to insert image.')
      )
    }
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
  }
}

function encodeMarkdownImageBasename(destPath: string): string {
  // Why: unescaped spaces and delimiters in markdown image destinations make
  // screenshot filenames render as literal text or broken partial paths.
  return encodeURIComponent(basename(destPath))
}

function getWorktreePath(
  state: ReturnType<typeof useAppStore.getState>,
  worktreeId: string | null,
  ownerHostId: ExecutionHostId | undefined
): string | null {
  if (!worktreeId || parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return null
  }
  const indexedOwner = ownerHostId
    ? findIndexedWorktreeOwnerForHost(state.worktreesByRepo, worktreeId, ownerHostId)
    : findIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  return (
    Object.values(state.worktreesByRepo ?? {})
      .flat()
      .find((worktree) => worktree === indexedOwner)?.path ?? null
  )
}

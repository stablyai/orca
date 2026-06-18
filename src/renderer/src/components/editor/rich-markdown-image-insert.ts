import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { dirname, basename } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'

export type RichMarkdownImageInsertArgs = {
  editor: Editor
  filePath: string
  sourcePath: string
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
  insertPos: number
  canInsert?: (editor: Editor) => boolean
}

export async function insertRichMarkdownImageFromPath({
  editor,
  filePath,
  sourcePath,
  worktreeId,
  runtimeEnvironmentId,
  insertPos,
  canInsert
}: RichMarkdownImageInsertArgs): Promise<void> {
  try {
    const connectionId = getConnectionId(worktreeId) ?? undefined
    const settings = settingsForRuntimeOwner(useAppStore.getState().settings, runtimeEnvironmentId)
    const worktreePath = getWorktreePath(worktreeId)
    if (settings?.activeRuntimeEnvironmentId?.trim() && !worktreePath) {
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
      {
        settings,
        worktreeId,
        worktreePath,
        connectionId
      },
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

    const inserted = editor
      .chain()
      .focus()
      .insertContentAt(insertPos, { type: 'image', attrs: { src: basename(imported.destPath) } })
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

function getWorktreePath(worktreeId: string | null): string | null {
  if (!worktreeId) {
    return null
  }
  const state = useAppStore.getState()
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return (
      state.folderWorkspaces.find(
        (workspace) => workspace.id === parsedWorkspaceKey.folderWorkspaceId
      )?.folderPath ?? null
    )
  }
  const worktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  return worktrees.find((worktree) => worktree.id === worktreeId)?.path ?? null
}

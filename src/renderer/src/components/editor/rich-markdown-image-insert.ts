import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { dirname, basename } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { editorTabDocumentFolderAccess } from '@/lib/local-file-access'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { translate } from '@/i18n/i18n'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { buildRichMarkdownImageInsertContent } from './rich-markdown-image-insert-content'
import { showRichMarkdownImageInsertionCanceled } from './rich-markdown-image-insertion-feedback'
import type { RichMarkdownImageInsertionRange } from './rich-markdown-image-insertion-target'
import { richMarkdownClipboardInsertionOrderKey } from './rich-markdown-clipboard-insertion-order'

export type RichMarkdownImageInsertArgs = {
  editor: Editor
  filePath: string
  sourcePath: string
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
  getInsertionRange: () => RichMarkdownImageInsertionRange | null
}

export async function insertRichMarkdownImageFromPath({
  editor,
  filePath,
  sourcePath,
  worktreeId,
  runtimeEnvironmentId,
  getInsertionRange
}: RichMarkdownImageInsertArgs): Promise<void> {
  try {
    const state = useAppStore.getState()
    const worktreePath = getWorktreePath(worktreeId)
    const parsedWorkspace = worktreeId ? parseWorkspaceKey(worktreeId) : null
    const resolvedConnectionId = getConnectionId(worktreeId)
    if (parsedWorkspace?.type === 'folder' && resolvedConnectionId === undefined) {
      throw new Error("Couldn't verify which host owns this file. Reopen the file and try again.")
    }
    const connectionId = resolvedConnectionId ?? undefined
    const fileContext =
      worktreeId && parsedWorkspace?.type !== 'folder'
        ? getEditorFileOperationContext(state, { worktreeId, runtimeEnvironmentId }, worktreePath)
        : {
            settings: settingsForRuntimeOwner(state.settings, runtimeEnvironmentId),
            worktreeId,
            worktreePath,
            connectionId,
            expectedExecutionHostId: connectionId
              ? (`ssh:${encodeURIComponent(connectionId)}` as const)
              : ('local' as const),
            ...(connectionId
              ? captureDirectSshMutationExpectation(state, connectionId, runtimeEnvironmentId)
              : {})
          }
    const settings = fileContext.settings
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
    // Why: a document opened outside every project still gets its image beside it.
    const openDocument = state.openFiles.find(
      (file) => file.filePath === filePath && file.worktreeId === worktreeId
    )
    const { results } = await importExternalPathsToRuntime(
      fileContext,
      [sourcePath],
      dirname(filePath),
      { access: openDocument ? editorTabDocumentFolderAccess(state, openDocument) : undefined }
    )
    const imported = results.find((result) => result.status === 'imported')
    if (!imported) {
      toast.error(
        translate('auto.components.editor.useLocalImagePick.175cb8b8ce', 'Failed to insert image.')
      )
      return
    }

    const range = getInsertionRange()
    if (!range) {
      showRichMarkdownImageInsertionCanceled(true)
      return
    }

    const imageSrc = encodeMarkdownImageBasename(imported.destPath)
    const selection = editor.state.selection
    const cellSelection = range.cellSelection
    const selectionStillAtTarget = cellSelection
      ? selection.eq(cellSelection)
      : selection.from === range.from && selection.to === range.to
    const chain = cellSelection
      ? editor.chain().command(({ tr }) => {
          const liveSelection = tr.selection
          cellSelection.replaceWith(tr, editor.schema.nodes.image.create({ src: imageSrc }))
          if (!selectionStillAtTarget) {
            tr.setSelection(liveSelection.map(tr.doc, tr.mapping))
          }
          return true
        })
      : editor
          .chain()
          .insertContentAt(
            range.from === range.to ? range.from : range,
            buildRichMarkdownImageInsertContent(editor, range.from, { src: imageSrc }),
            { updateSelection: selectionStillAtTarget }
          )
    const inserted = chain.setMeta(richMarkdownClipboardInsertionOrderKey, range.requestOrder).run()
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

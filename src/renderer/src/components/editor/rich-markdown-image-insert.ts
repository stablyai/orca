import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { dirname, basename } from '@/lib/path'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-import-client'
import { getEditorFileOperationContext } from '@/lib/editor-file-operation-owner'
import { editorTabDocumentFolderAccess } from '@/lib/local-file-access'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { captureDirectSshMutationExpectation } from '@/lib/ssh-mutation-expectation'
import { translate } from '@/i18n/i18n'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { buildRichMarkdownImageInsertContent } from './rich-markdown-image-insert-content'
import { showRichMarkdownImageInsertionCanceled } from './rich-markdown-image-insertion-feedback'
import type { RichMarkdownImageInsertionRange } from './rich-markdown-image-insertion-target'
import { richMarkdownClipboardInsertionOrderKey } from './rich-markdown-clipboard-insertion-order'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
import type { LocalFileAccess } from '../../../../shared/local-file-access'

export type RichMarkdownImageInsertArgs = {
  editor: Editor
  filePath: string
  sourcePath: string
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
  getInsertionRange: () => RichMarkdownImageInsertionRange | null
}

export type RichMarkdownImageImportDestination = {
  context: RuntimeFileOperationArgs
  destinationDir: string
  access: LocalFileAccess | undefined
}

/** Resolves where image bytes for this note are saved; null after reporting a missing worktree path. */
export function captureRichMarkdownImageImportDestination({
  filePath,
  worktreeId,
  runtimeEnvironmentId
}: Pick<
  RichMarkdownImageInsertArgs,
  'filePath' | 'worktreeId' | 'runtimeEnvironmentId'
>): RichMarkdownImageImportDestination | null {
  const state = useAppStore.getState()
  const worktreePath = getWorktreePath(worktreeId)
  const parsedWorkspace = worktreeId ? parseWorkspaceKey(worktreeId) : null
  const resolvedConnectionId = getConnectionId(worktreeId)
  if (parsedWorkspace?.type === 'folder' && resolvedConnectionId === undefined) {
    throw new Error(
      translate(
        'auto.components.editor.richMarkdownImageInsert.hostUnverified',
        "Couldn't verify which host owns this file. Reopen the file and try again."
      )
    )
  }
  const connectionId = resolvedConnectionId ?? undefined
  const fileContext =
    worktreeId && parsedWorkspace?.type !== 'folder'
      ? getEditorFileOperationContext(state, { worktreeId, runtimeEnvironmentId }, worktreePath)
      : {
          target: requireRuntimeTargetForFileOwner(state, worktreeId, runtimeEnvironmentId),
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
  if (fileContext.target.kind === 'environment' && !worktreePath) {
    toast.error(
      translate(
        'auto.components.editor.useLocalImagePick.91d835dc88',
        'Worktree path not available.'
      )
    )
    return null
  }

  // Save image bytes beside the note, including outside projects, so rich-mode size checks measure document text only.
  const openDocument = state.openFiles.find(
    (file) => file.filePath === filePath && file.worktreeId === worktreeId
  )
  return {
    context: fileContext,
    destinationDir: dirname(filePath),
    access: openDocument ? editorTabDocumentFolderAccess(state, openDocument) : undefined
  }
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
    const destination = captureRichMarkdownImageImportDestination({
      filePath,
      worktreeId,
      runtimeEnvironmentId
    })
    if (!destination) {
      return
    }
    const { results } = await importExternalPathsToRuntime(
      destination.context,
      [sourcePath],
      destination.destinationDir,
      { access: destination.access }
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
    toast.error(
      extractIpcErrorMessage(
        err,
        translate('auto.components.editor.useLocalImagePick.175cb8b8ce', 'Failed to insert image.')
      )
    )
  }
}

export function encodeMarkdownImageBasename(destPath: string): string {
  // Escape filename spaces and delimiters or Markdown interprets them as broken destinations or literal text.
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
      selectFolderWorkspaces(state).find(
        (workspace) => workspace.id === parsedWorkspaceKey.folderWorkspaceId
      )?.folderPath ?? null
    )
  }
  const worktrees = Object.values(selectWorktreesByRepo(state) ?? {}).flat()
  return worktrees.find((worktree) => worktree.id === worktreeId)?.path ?? null
}

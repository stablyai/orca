import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import {
  resolveRichMarkdownFileOwner,
  type RichMarkdownFileOwner
} from './rich-markdown-file-owner'

export type RichMarkdownImagePasteArgs = {
  editor: Editor | null
  event: ClipboardEvent
  fileId: string
  filePath: string
  worktreeId: string | null
  runtimeEnvironmentId?: string | null
}

export function clipboardHasImage(event: ClipboardEvent): boolean {
  const data = event.clipboardData
  if (!data) {
    return false
  }
  return Array.from(data.items).some(
    (item) => item.kind === 'file' && item.type.startsWith('image/')
  )
}

export function handleRichMarkdownImagePaste({
  editor,
  event,
  fileId,
  filePath,
  worktreeId,
  runtimeEnvironmentId
}: RichMarkdownImagePasteArgs): boolean {
  if (!editor || !clipboardHasImage(event)) {
    return false
  }

  event.preventDefault()
  const insertPos = editor.state.selection.from
  const targetDom = editor.view.dom
  const fileOwner = worktreeId
    ? resolveRichMarkdownFileOwner(useAppStore.getState(), fileId, filePath, worktreeId)
    : null
  if (!fileOwner) {
    toast.error(
      translate(
        'auto.components.right.sidebar.useFileDeletion.8b8ee9d22f',
        "Couldn't determine which host owns this file. Check the workspace connection and try again."
      )
    )
    return true
  }

  void saveClipboardImageForMarkdownPaste(fileOwner)
    .then((sourcePath) => {
      if (!sourcePath || !isRichMarkdownImagePasteTargetAvailable(editor, targetDom)) {
        return
      }
      return insertRichMarkdownImageFromPath({
        editor,
        fileId,
        filePath,
        sourcePath,
        worktreeId,
        runtimeEnvironmentId,
        insertPos,
        canInsert: (candidate) => isRichMarkdownImagePasteTargetAvailable(candidate, targetDom)
      })
    })
    .catch((err) => {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    })

  return true
}

function isRichMarkdownImagePasteTargetAvailable(editor: Editor, targetDom: HTMLElement): boolean {
  return !editor.isDestroyed && editor.view.dom === targetDom && targetDom.isConnected
}

async function saveClipboardImageForMarkdownPaste(
  fileOwner: RichMarkdownFileOwner
): Promise<string | null> {
  const hasRuntimeOwner = Boolean(
    fileOwner.operationContext.settings?.activeRuntimeEnvironmentId?.trim()
  )
  // Why: runtime-owned notes use runtime-side clipboard import; routing this
  // temp save through SSH would put the source file on the wrong machine.
  const connectionId = hasRuntimeOwner ? undefined : fileOwner.operationContext.connectionId

  return window.api.ui.saveClipboardImageAsTempFile({ connectionId })
}

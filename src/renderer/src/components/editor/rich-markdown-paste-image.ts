import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { captureRichMarkdownImageInsertionTarget } from './rich-markdown-image-insertion-target'
import { showRichMarkdownImageInsertionCanceled } from './rich-markdown-image-insertion-feedback'

export type RichMarkdownImagePasteArgs = {
  editor: Editor | null
  event: ClipboardEvent
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
  filePath,
  worktreeId,
  runtimeEnvironmentId
}: RichMarkdownImagePasteArgs): boolean {
  if (!editor || !clipboardHasImage(event)) {
    return false
  }

  event.preventDefault()
  const target = captureRichMarkdownImageInsertionTarget(editor)
  if (!target) {
    return true
  }

  void saveClipboardImageForMarkdownPaste(worktreeId, runtimeEnvironmentId)
    .then((sourcePath) => {
      if (!sourcePath) {
        return
      }
      if (!target.getRange()) {
        showRichMarkdownImageInsertionCanceled()
        return
      }
      return insertRichMarkdownImageFromPath({
        editor,
        filePath,
        sourcePath,
        worktreeId,
        runtimeEnvironmentId,
        getInsertionRange: target.getRange
      })
    })
    .catch((err) => {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    })
    .finally(target.dispose)

  return true
}

async function saveClipboardImageForMarkdownPaste(
  worktreeId: string | null,
  runtimeEnvironmentId?: string | null
): Promise<string | null> {
  const hasRuntimeOwner =
    requireRuntimeTargetForFileOwner(useAppStore.getState(), worktreeId, runtimeEnvironmentId)
      .kind === 'environment'
  // Why: runtime-owned notes use runtime-side clipboard import; routing this
  // temp save through SSH would put the source file on the wrong machine.
  const connectionId = hasRuntimeOwner ? undefined : (getConnectionId(worktreeId) ?? undefined)

  return window.api.ui.saveClipboardImageAsTempFile({ connectionId })
}

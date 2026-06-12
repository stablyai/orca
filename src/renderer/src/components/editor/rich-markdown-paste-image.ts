import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'

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
  const insertPos = editor.state.selection.from

  void saveClipboardImageForMarkdownPaste(worktreeId, runtimeEnvironmentId)
    .then((sourcePath) => {
      if (!sourcePath) {
        return
      }
      return insertRichMarkdownImageFromPath({
        editor,
        filePath,
        sourcePath,
        worktreeId,
        runtimeEnvironmentId,
        insertPos
      })
    })
    .catch((err) => {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    })

  return true
}

async function saveClipboardImageForMarkdownPaste(
  worktreeId: string | null,
  runtimeEnvironmentId?: string | null
): Promise<string | null> {
  const settings = settingsForRuntimeOwner(useAppStore.getState().settings, runtimeEnvironmentId)
  const hasRuntimeOwner = Boolean(settings?.activeRuntimeEnvironmentId?.trim())
  // Why: runtime-owned notes use runtime-side clipboard import; routing this
  // temp save through SSH would put the source file on the wrong machine.
  const connectionId = hasRuntimeOwner ? undefined : (getConnectionId(worktreeId) ?? undefined)

  return window.api.ui.saveClipboardImageAsTempFile({ connectionId })
}

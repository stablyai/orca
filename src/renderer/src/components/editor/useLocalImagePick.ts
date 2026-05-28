import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Editor } from '@tiptap/react'
import { extractIpcErrorMessage, getImageCopyDestination } from './rich-markdown-image-utils'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { basename, dirname } from '@/lib/path'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'

export function useLocalImagePick(
  editor: Editor | null,
  filePath: string,
  worktreeId: string | null,
  runtimeEnvironmentId?: string | null
): () => Promise<void> {
  return useCallback(async () => {
    if (!editor) {
      return
    }
    // Why: the native file picker steals focus from the editor, which can cause
    // ProseMirror to lose track of its selection. We snapshot the cursor position
    // before the async dialog so we can insert the image exactly where the user
    // intended, not at whatever position focus() falls back to afterward.
    const insertPos = editor.state.selection.from
    try {
      const srcPath = await window.api.shell.pickImage()
      if (!srcPath) {
        return
      }
      const connectionId = getConnectionId(worktreeId) ?? undefined
      const settings = settingsForRuntimeOwner(
        useAppStore.getState().settings,
        runtimeEnvironmentId
      )
      if (settings?.activeRuntimeEnvironmentId?.trim() || connectionId) {
        const worktreePath = getWorktreePath(worktreeId)
        if (settings?.activeRuntimeEnvironmentId?.trim() && !worktreePath) {
          toast.error('Worktree path not available.')
          return
        }
        // Why: picked images are client-local files while remote markdown lives
        // on the server. Upload beside the markdown file before inserting the
        // relative image path so preview/save works from any client.
        const { results } = await importExternalPathsToRuntime(
          {
            settings,
            worktreeId,
            worktreePath,
            connectionId
          },
          [srcPath],
          dirname(filePath)
        )
        const imported = results.find((result) => result.status === 'imported')
        if (!imported) {
          toast.error('Failed to insert image.')
          return
        }
        editor
          .chain()
          .focus()
          .insertContentAt(insertPos, {
            type: 'image',
            attrs: { src: basename(imported.destPath) }
          })
          .run()
        return
      }
      // Why: copy the image next to the markdown file and insert a relative path
      // so the markdown stays portable and doesn't bloat with base64 data.
      const { imageName, destPath } = await getImageCopyDestination(filePath, srcPath)
      if (srcPath !== destPath) {
        await window.api.shell.copyFile({ srcPath, destPath })
      }
      // Why: insertContentAt places the image at the exact saved position
      // regardless of where focus lands after the native file dialog closes,
      // whereas setTextSelection can be overridden by ProseMirror's focus logic.
      editor
        .chain()
        .focus()
        .insertContentAt(insertPos, { type: 'image', attrs: { src: imageName } })
        .run()
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    }
  }, [editor, filePath, runtimeEnvironmentId, worktreeId])
}

function getWorktreePath(worktreeId: string | null): string | null {
  if (!worktreeId) {
    return null
  }
  const state = useAppStore.getState()
  const worktrees = Object.values(state.worktreesByRepo ?? {}).flat()
  return worktrees.find((worktree) => worktree.id === worktreeId)?.path ?? null
}

import { useCallback } from 'react'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'

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
    const targetDom = editor.view.dom
    try {
      const srcPaths = await window.api.shell.pickImages()
      if (srcPaths.length === 0) {
        return
      }
      // Why: insertContentAt with a fixed position inserts in reverse order
      // when called repeatedly. Reversing preserves the user's selection order.
      for (const srcPath of srcPaths.toReversed()) {
        await insertRichMarkdownImageFromPath({
          editor,
          filePath,
          sourcePath: srcPath,
          worktreeId,
          runtimeEnvironmentId,
          insertPos,
          canInsert: (candidate) =>
            !candidate.isDestroyed && candidate.view.dom === targetDom && targetDom.isConnected
        })
      }
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    }
  }, [editor, filePath, runtimeEnvironmentId, worktreeId])
}

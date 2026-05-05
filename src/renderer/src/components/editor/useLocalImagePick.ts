import { useCallback } from 'react'
import { toast } from 'sonner'
import type { Editor } from '@tiptap/react'
import { extractIpcErrorMessage, getImageCopyDestination } from './rich-markdown-image-utils'

export function useLocalImagePick(editor: Editor | null, filePath: string): () => Promise<void> {
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
  }, [editor, filePath])
}

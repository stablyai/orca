import { useCallback, useLayoutEffect, useRef } from 'react'
import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'
import { extractIpcErrorMessage } from './rich-markdown-ipc-error-message'
import { showRichMarkdownImageInsertionCanceled } from './rich-markdown-image-insertion-feedback'
import {
  captureRichMarkdownImageInsertionTarget,
  type RichMarkdownImageInsertionTarget
} from './rich-markdown-image-insertion-target'

export function useLocalImagePick(
  editor: Editor | null,
  filePath: string,
  worktreeId: string | null,
  runtimeEnvironmentId?: string | null
): () => Promise<void> {
  const pendingTargetsRef = useRef(new Set<RichMarkdownImageInsertionTarget>())
  useLayoutEffect(() => {
    const pendingTargets = pendingTargetsRef.current
    return () => {
      pendingTargets.forEach((target) => target.dispose())
      pendingTargets.clear()
    }
  }, [editor, filePath, runtimeEnvironmentId, worktreeId])

  return useCallback(async () => {
    if (!editor) {
      return
    }
    const target = captureRichMarkdownImageInsertionTarget(editor)
    if (!target) {
      return
    }
    pendingTargetsRef.current.add(target)
    try {
      const srcPath = await window.api.shell.pickImage()
      if (!srcPath) {
        return
      }
      if (!target.getRange()) {
        showRichMarkdownImageInsertionCanceled()
        return
      }
      await insertRichMarkdownImageFromPath({
        editor,
        filePath,
        sourcePath: srcPath,
        worktreeId,
        runtimeEnvironmentId,
        getInsertionRange: target.getRange
      })
    } catch (err) {
      toast.error(extractIpcErrorMessage(err, 'Failed to insert image.'))
    } finally {
      target.dispose()
      pendingTargetsRef.current.delete(target)
    }
  }, [editor, filePath, runtimeEnvironmentId, worktreeId])
}

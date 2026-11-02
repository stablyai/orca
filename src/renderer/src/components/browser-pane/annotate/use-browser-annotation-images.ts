import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'
import { useMountedRef } from '@/hooks/useMountedRef'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { formatClipboardImagePasteError } from '@/components/terminal-pane/terminal-pane-paste-execution'
import { resolveTerminalPasteRuntimeEnvironmentId } from '@/components/terminal-pane/terminal-paste-runtime'
import { clipboardEventImageFile } from '@/components/native-chat/native-chat-clipboard-payload'
import { useNativeChatComposerAttachmentPreviews } from '@/components/native-chat/use-native-chat-composer-attachment-previews'
import type { NativeChatComposerImageAttachment } from '@/components/native-chat/NativeChatComposerField'

const NO_PENDING: readonly NativeChatComposerImageAttachment[] = []

/** Save where a terminal paste in this worktree would, so the agent can open the path. */
function saveAnnotationClipboardImage(worktreeId: string): Promise<string | null> {
  return window.api.ui.saveClipboardImageAsTempFile({
    connectionId: getConnectionId(worktreeId) ?? null,
    runtimeEnvironmentId: resolveTerminalPasteRuntimeEnvironmentId(
      useAppStore.getState(),
      worktreeId,
      null
    )
  })
}

export function useBrowserAnnotationImages(worktreeId: string): {
  images: NativeChatComposerImageAttachment[]
  imagePaths: string[]
  saving: boolean
  handlePaste: (event: React.ClipboardEvent) => void
  removeImage: (id: string) => void
  resetImages: (paths?: readonly string[]) => void
} {
  const mountedRef = useMountedRef()
  const [images, setImages] = useState<NativeChatComposerImageAttachment[]>([])
  // Releases each clipboard preview once its image leaves the list or the field unmounts.
  const { previews, setPreview } = useNativeChatComposerAttachmentPreviews(images, NO_PENDING)

  const removeImage = useCallback((id: string): void => {
    setImages((current) => current.filter((image) => image.id !== id))
  }, [])

  const handlePaste = useCallback(
    (event: React.ClipboardEvent): void => {
      // Text wins, as in a terminal: rich copies often carry an image rendition of their text.
      const file = event.clipboardData.getData('text/plain') ? null : clipboardEventImageFile(event)
      if (!file) {
        return
      }
      event.preventDefault()
      const id = createBrowserUuid()
      setImages((current) => [...current, { id, path: '', pending: true }])
      setPreview(id, URL.createObjectURL(file))
      const settle = (path: string | null): void => {
        if (!mountedRef.current) {
          return
        }
        if (!path) {
          removeImage(id)
          return
        }
        setImages((current) =>
          current.map((image) => (image.id === id ? { ...image, path, pending: false } : image))
        )
      }
      saveAnnotationClipboardImage(worktreeId).then(settle, (error: unknown) => {
        settle(null)
        toast.error(formatClipboardImagePasteError(error))
      })
    },
    [mountedRef, removeImage, setPreview, worktreeId]
  )

  const resetImages = useCallback((paths: readonly string[] = []): void => {
    setImages(paths.map((path) => ({ id: path, path })))
  }, [])

  return {
    images: images.map((image) =>
      previews.has(image.id) ? { ...image, previewUrl: previews.get(image.id) } : image
    ),
    imagePaths: images.flatMap((image) => (image.pending ? [] : [image.path])),
    saving: images.some((image) => image.pending),
    handlePaste,
    removeImage,
    resetImages
  }
}

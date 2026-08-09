import { useEffect, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { APP_MENU_PASTE_EVENT } from '../../lib/app-menu-paste'

export function listenForRoomComposerAppMenuPaste(
  root: HTMLElement,
  onPaste: () => void
): () => void {
  const listener = (event: Event): void => {
    const activeElement = document.activeElement
    if (!(activeElement instanceof Element) || !root.contains(activeElement)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    onPaste()
  }
  window.addEventListener(APP_MENU_PASTE_EVENT, listener)
  return () => window.removeEventListener(APP_MENU_PASTE_EVENT, listener)
}

export async function readRoomComposerClipboardImage(): Promise<File | null> {
  const image = await window.api.ui.readClipboardImage()
  if (!image) {
    return null
  }
  return new File([image.content], 'pasted-image.png', { type: image.mimeType })
}

export function useRoomComposerClipboardPaste(
  rootRef: RefObject<HTMLElement | null>,
  attachFiles: (files: File[]) => Promise<void>
): void {
  const attachFilesRef = useRef(attachFiles)
  attachFilesRef.current = attachFiles

  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return
    }
    return listenForRoomComposerAppMenuPaste(root, () => {
      const activeElement = document.activeElement
      void readRoomComposerClipboardImage()
        .then((image) => {
          if (document.activeElement !== activeElement || !root.contains(activeElement)) {
            return
          }
          if (image) {
            void attachFilesRef.current([image])
          } else {
            window.api.ui.performNativePaste()
          }
        })
        .catch((error) => {
          toast.error(
            extractIpcErrorMessage(
              error,
              translate('rooms.composer.imagePasteFailed', 'Image paste failed.')
            )
          )
        })
    })
  }, [rootRef])
}

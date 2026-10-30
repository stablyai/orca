import { isWebClientLocation } from '@/lib/web-client-location'
import { captureImageSource } from '@/lib/image-source-actions'
export { copyImageSource as copyNativeChatImage } from '@/lib/image-source-actions'

/** The chat context menu offers "Copy image" for elements carrying this attribute. */
const COPY_IMAGE_SRC_SELECTOR = '[data-native-chat-copy-image-src]'

export function copyableNativeChatImageSrc(src: string | undefined): string | undefined {
  // The web client's image clipboard write is a no-op.
  return isWebClientLocation() ? undefined : src
}

export type NativeChatCopyImage = () => Promise<Blob>

/** Captures revocable sources now; remote URLs are read only when copying is selected. */
export function readNativeChatCopyImage(
  target: EventTarget | null
): NativeChatCopyImage | undefined {
  const src =
    target instanceof Element
      ? target.closest(COPY_IMAGE_SRC_SELECTOR)?.getAttribute('data-native-chat-copy-image-src')
      : undefined
  if (!src) {
    return undefined
  }
  return captureImageSource(src)
}

/** Keeps an image preview open through clicks on the chat context menu. */
export function keepPreviewOpenForChatMenu(event: {
  target: EventTarget | null
  preventDefault: () => void
}): void {
  // Why: the menu portals outside the preview, so Radix counts a click on it as outside.
  if (event.target instanceof Element && event.target.closest('[data-native-chat-context-menu]')) {
    event.preventDefault()
  }
}

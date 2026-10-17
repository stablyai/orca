import { isWebClientLocation } from '@/lib/web-client-location'

/** The chat context menu offers "Copy image" for elements carrying this attribute. */
const COPY_IMAGE_SRC_SELECTOR = '[data-native-chat-copy-image-src]'

/** Full-size source to copy for an image, or undefined when it has none. */
export function copyableNativeChatImageSrc(src: string | undefined): string | undefined {
  // The web client's image clipboard write is a no-op.
  return isWebClientLocation() ? undefined : src
}

export type NativeChatCopyImage = () => Promise<Blob>

async function readImageBlob(src: string): Promise<Blob> {
  const response = await fetch(src)
  if (!response.ok) {
    throw new Error(`Image request failed (HTTP ${response.status})`)
  }
  const blob = await response.blob()
  if (blob.type.split(';', 1)[0] === 'text/html') {
    throw new Error('The image URL returned a web page')
  }
  return blob
}

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
  if (/^https?:/i.test(src)) {
    return () => readImageBlob(src)
  }
  const image = readImageBlob(src)
  // Why: a read the user never copies must not surface as an unhandled rejection.
  image.catch(() => {})
  return () => image
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

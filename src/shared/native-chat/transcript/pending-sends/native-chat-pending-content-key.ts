import { readAgentImageSourceContext } from '../../input/composer/agent-image-paste'
import { normalizeNativeChatUserText } from '../images/native-chat-image-transcript-markers'
import type { NativeChatPendingOccurrence } from './native-chat-pending-occurrence'

export function nativeChatPendingContentKey(
  pending: Pick<NativeChatPendingOccurrence, 'text' | 'imagePaths' | 'images'>
): string {
  const text = normalizeNativeChatUserText(pending.text)
  if (text) {
    if (readAgentImageSourceContext(pending.text).original.length) {
      const paths = pending.imagePaths?.filter(Boolean) ?? []
      const attachments = paths.length ? paths : (pending.images?.length ?? 0)
      return `text:${text}\0attachments:${JSON.stringify(attachments)}`
    }
    return `text:${text}`
  }
  const imagePaths = pending.imagePaths?.filter(Boolean) ?? []
  return imagePaths.length > 0 ? `images:${JSON.stringify(imagePaths)}` : 'empty'
}

// A file path written out in an item's description reads as its file name; the path stays on hover.
import { routeNativeChatHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { botItemFileName } from '../../../../../shared/bots/bot-item-link-names'

/** The file name a file link shows in place of its text, or null to keep the text: only a link to a
 *  file whose text is itself a path (a bare path, not words someone chose for the link). */
export function botItemFileLinkName(href: string | undefined, text: string): string | null {
  if (routeNativeChatHref(href).kind !== 'file') {
    return null
  }
  const path = text.trim().replace(/[\\/]+$/, '')
  if (!/[\\/]/.test(path) || /\s/.test(path)) {
    return null
  }
  return botItemFileName(path) || null
}

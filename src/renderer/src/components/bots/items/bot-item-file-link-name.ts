// A file path written out in an item's description reads as its file name; the path stays on hover.
import { routeNativeChatHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import { botItemFileName } from '../../../../../shared/bots/bot-item-link-names'

/** The file name a file link shows in place of its text, or null to keep the text: only a link to a
 *  file whose text is itself a path (a bare path, not words someone chose for the link). */
export function botItemFileLinkName(href: string | undefined, text: string): string | null {
  const target = routeNativeChatHref(href)
  if (target.kind !== 'file') {
    return null
  }
  const label = text.trim()
  if (label !== target.pathText && label !== href?.trim()) {
    return null
  }
  const path = label.replace(/[\\/]+$/, '')
  return /[\\/]/.test(path) ? botItemFileName(path) : null
}

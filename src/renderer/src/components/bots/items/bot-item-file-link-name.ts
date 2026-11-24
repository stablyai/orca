// A file path written out in an item's description reads as its file name; the full path stays on hover.
import { routeNativeChatHref } from '../../../../../shared/native-chat/file-access/native-chat-href-routing'
import {
  formatFileLinkLocation,
  parseFileLinkLocation
} from '../../../../../shared/file-links/file-link-location'
import { botItemFileName } from '../../../../../shared/bots/bot-item-link-names'

export type BotItemFileLinkName = { name: string; path: string }

/** `path:line:column` with the numbers as the detector writes them (`a.ts:003:02` → `a.ts:3:2`). */
function location(value: string): string {
  const parsed = parseFileLinkLocation(value)
  return parsed ? formatFileLinkLocation(parsed) : value
}

/** The ways a link's text can name its destination: as written, or as the detector re-encodes it (a
 *  `file://` URI read as a filesystem path, location numbers without padding). */
function labelPaths(label: string): string[] {
  const paths = [label, location(label)]
  const route = /^file:/i.test(label) ? routeNativeChatHref(label) : null
  if (route?.kind === 'file') {
    paths.push(location(formatFileLinkLocation(route)))
  }
  return paths
}

/** The file name a file link shows in place of its text, and the full path for its tooltip, or null to
 *  keep the text: only a link to a file whose text is itself that path (a bare path, not words someone
 *  chose for the link). */
export function botItemFileLinkName(
  href: string | undefined,
  text: string
): BotItemFileLinkName | null {
  const target = routeNativeChatHref(href)
  if (target.kind !== 'file') {
    return null
  }
  const label = text.trim()
  const destination = formatFileLinkLocation(target)
  const destinations = new Set([destination, location(destination), target.pathText, href?.trim()])
  if (!labelPaths(label).some((path) => destinations.has(path))) {
    return null
  }
  const path = destination.replace(/[\\/]+$/, '')
  return /[\\/]/.test(path) ? { name: botItemFileName(path), path } : null
}

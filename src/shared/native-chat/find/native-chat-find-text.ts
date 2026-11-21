import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { NativeChatMessage } from '../native-chat-types'
import { nativeChatMessageCopyText } from '../transcript/messages/native-chat-message-copy-text'

const markdownParser = unified().use(remarkParse).use(remarkGfm)

/** Find reads people's and the agent's words; tools, reasoning and notices stay out, as in the bar. */
export function nativeChatFindSourceText(
  message: Pick<NativeChatMessage, 'role' | 'blocks'>
): string | null {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return null
  }
  const text = nativeChatMessageCopyText(message)
  return text.trim() ? text : null
}

function collectSegments(node: Nodes, segments: string[]): void {
  if (node.type === 'html') {
    return
  }
  if ('value' in node && typeof node.value === 'string') {
    segments.push(node.value)
    return
  }
  if ('children' in node) {
    for (const child of node.children) {
      collectSegments(child, segments)
    }
  }
}

/** The text runs a message draws, as find can match them: one per rendered text node. */
export function nativeChatFindSegments(source: string): string[] {
  const segments: string[] = []
  collectSegments(markdownParser.parse(source), segments)
  return segments
}

/** Case-insensitive, non-overlapping, as the bar highlights. */
export function countNativeChatFindMatches(text: string, foldedQuery: string): number {
  if (!foldedQuery) {
    return 0
  }
  const folded = text.toLocaleLowerCase()
  let count = 0
  for (
    let at = folded.indexOf(foldedQuery);
    at !== -1;
    at = folded.indexOf(foldedQuery, at + foldedQuery.length)
  ) {
    count += 1
  }
  return count
}

export function foldNativeChatFindQuery(query: string): string {
  return query.toLocaleLowerCase()
}

/** Every drawn text run is a literal slice of the source unless an entity or escape rewrote it, so
 *  a source without the query and without either needs no parse. */
export function nativeChatFindSourceMayMatch(source: string, foldedQuery: string): boolean {
  return (
    source.toLocaleLowerCase().includes(foldedQuery) ||
    source.includes('&') ||
    source.includes('\\')
  )
}

export function countNativeChatFindSegments(
  segments: readonly string[],
  foldedQuery: string
): number {
  let count = 0
  for (const segment of segments) {
    count += countNativeChatFindMatches(segment, foldedQuery)
  }
  return count
}

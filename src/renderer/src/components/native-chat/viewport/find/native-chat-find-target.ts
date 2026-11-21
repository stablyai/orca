import type { NativeChatFindPosition } from '../../../../../../shared/native-chat/find/native-chat-session-find'

const FIND_ENTRY_ATTRIBUTE = 'data-native-chat-find-entry'
const TRANSCRIPT_SCROLL_SELECTOR = '[data-native-chat-scroll]'

/** The message the reader is looking at: the first find row reaching into the transcript's view. */
export function nativeChatFindStartOnScreen(
  root: HTMLElement | null
): NativeChatFindPosition | undefined {
  const scroller = root?.querySelector(TRANSCRIPT_SCROLL_SELECTOR)
  if (!root || !scroller) {
    return undefined
  }
  const top = scroller.getBoundingClientRect().top
  for (const row of root.querySelectorAll<HTMLElement>(`[${FIND_ENTRY_ATTRIBUTE}]`)) {
    if (row.getBoundingClientRect().bottom > top) {
      return { entryId: row.getAttribute(FIND_ENTRY_ATTRIBUTE)!, occurrence: 0 }
    }
  }
  return undefined
}

/** The drawn range of a host match: its message row's nth match, or its last when the row draws
 *  fewer; undefined while the row is not drawn. */
export function nativeChatFindTargetRange(
  column: Element | null,
  matches: readonly Range[],
  target: NativeChatFindPosition
): Range | undefined {
  const row = column?.querySelector(`[${FIND_ENTRY_ATTRIBUTE}="${CSS.escape(target.entryId)}"]`)
  const inRow = row ? matches.filter((match) => row.contains(match.startContainer)) : []
  return inRow[Math.min(target.occurrence, inRow.length - 1)]
}

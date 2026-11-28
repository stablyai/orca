/** The active match by its transcript row and place in it: DOM nodes don't survive a remount, row keys do. */
export type KeptMatch = { query: string; rowKey: string; nth: number }

const ROW_KEY_SELECTOR = '[data-native-chat-row-key]'

function rowOf(match: Range): Element | null {
  const start = match.startContainer
  return (start instanceof Element ? start : start.parentElement)?.closest(ROW_KEY_SELECTOR) ?? null
}

export function keptMatchOf(
  matches: readonly Range[],
  index: number,
  query: string
): KeptMatch | null {
  const row = rowOf(matches[index])
  const rowKey = row?.getAttribute('data-native-chat-row-key')
  if (!row || !rowKey) {
    return null
  }
  let nth = 0
  for (let at = 0; at < index; at++) {
    if (rowOf(matches[at]) === row) {
      nth++
    }
  }
  return { query, rowKey, nth }
}

export function keptMatchIndex(matches: readonly Range[], kept: KeptMatch): number {
  let nth = 0
  for (const [index, match] of matches.entries()) {
    if (rowOf(match)?.getAttribute('data-native-chat-row-key') === kept.rowKey) {
      if (nth === kept.nth) {
        return index
      }
      nth++
    }
  }
  return -1
}

// Filter the rail list over each prompt's first 200 characters, mapping matches back to original text offsets.

import {
  buildLocaleLowercaseIndex,
  type LocaleLowercaseIndex
} from '../../../../../../shared/locale-lowercase-index'
import {
  AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS,
  truncateOutlinePreview
} from '../../../../../../shared/agent-session/view/messages/agent-session-conversation-outline'
import { getIntlLocale } from '@/i18n/i18n'
import type { NativeChatRailItem } from './native-chat-message-rail-items'

export type NativeChatRailMatch = { start: number; end: number }

export type NativeChatRailResult = {
  item: NativeChatRailItem
  match: NativeChatRailMatch | null
}

// Items keep identity across stream frames, so each prompt is indexed once.
const searchIndexes = new WeakMap<NativeChatRailItem, LocaleLowercaseIndex>()

function searchIndexOf(item: NativeChatRailItem): LocaleLowercaseIndex {
  let index = searchIndexes.get(item)
  if (!index) {
    // Fallback labels ("Image attachment") describe the row, not its words, so they are not searchable.
    index = buildLocaleLowercaseIndex(
      truncateOutlinePreview(item.text, AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS)
    )
    searchIndexes.set(item, index)
  }
  return index
}

export function filterNativeChatRailItems(
  items: readonly NativeChatRailItem[],
  query: string
): readonly NativeChatRailResult[] {
  const needle = buildLocaleLowercaseIndex(query.trim()).text
  if (needle.length === 0) {
    return items.map((item) => ({ item, match: null }))
  }
  const results: NativeChatRailResult[] = []
  for (const item of items) {
    const index = searchIndexOf(item)
    const at = index.text.indexOf(needle)
    if (at === -1) {
      continue
    }
    const last = at + needle.length - 1
    results.push({
      item,
      match: {
        start: index.originalStartByNormalizedOffset?.[at] ?? at,
        end: index.originalEndByNormalizedOffset?.[last] ?? last + 1
      }
    })
  }
  return results
}

export type NativeChatRailRowDisplay = {
  text: string
  mark: NativeChatRailMatch | null
}

const LEADING_ELLIPSIS = '…'

let graphemes: Intl.Segmenter | null | undefined

/** Widen a range to whole graphemes, so neither the cut nor the mark splits a cluster. */
function graphemeRange(text: string, { start, end }: NativeChatRailMatch): NativeChatRailMatch {
  if (graphemes === undefined) {
    graphemes =
      typeof Intl.Segmenter === 'function'
        ? new Intl.Segmenter(getIntlLocale(), { granularity: 'grapheme' })
        : null
  }
  if (!graphemes || end <= start) {
    return { start, end }
  }
  const segments = graphemes.segment(text)
  const first = segments.containing(start)
  const last = segments.containing(end - 1)
  return {
    start: first?.index ?? start,
    end: last ? last.index + last.segment.length : end
  }
}

/** Start a matched row at its match, so the mark is not lost past the cell's trailing ellipsis. */
export function nativeChatRailRowDisplay(
  label: string,
  match: NativeChatRailMatch | null
): NativeChatRailRowDisplay {
  if (match === null) {
    return { text: label, mark: null }
  }
  const mark = graphemeRange(label, match)
  if (mark.start === 0) {
    return { text: label, mark }
  }
  const shift = LEADING_ELLIPSIS.length - mark.start
  return {
    text: LEADING_ELLIPSIS + label.slice(mark.start),
    mark: { start: LEADING_ELLIPSIS.length, end: mark.end + shift }
  }
}

// First-paint height for a transcript row. Windowing has to place every row —
// including the thousand nobody has looked at — before any of them has been
// measured, so the estimate only has to be close enough that the scrollbar
// doesn't lurch once the real measurement lands.
//
// Deliberately arithmetic over already-derived content: `estimateSize` is called
// once per item every time a measurement resolves, so anything that walks blocks
// or joins strings here would turn one row's ResizeObserver callback into a
// whole-transcript scan.

import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { deriveNativeChatRowContent } from './native-chat-row-content'

/** What a row contains, reduced to the few numbers that drive its height. */
export type NativeChatRowContentMetrics = {
  role: NativeChatMessage['role']
  /** Wrapped display lines of prose, not source lines. */
  textLines: number
  imageCount: number
  toolCount: number
  subagentGroupCount: number
}

/** Extras the message itself doesn't know about — they come from the turn. */
export type NativeChatRowChromeMetrics = {
  hasReceipt: boolean
  hasStatus: boolean
  hasTurnDiff: boolean
}

const LINE_HEIGHT_PX = 22
const CHARS_PER_LINE = 96
const PROSE_MIN_LINES = 1
const USER_BUBBLE_CHROME_PX = 32
const IMAGE_STRIP_PX = 88
const TOOL_RUN_PX = 40
const SUBAGENT_ROW_PX = 32
const STATUS_ROW_PX = 28
const TURN_DIFF_PX = 28
const RECEIPT_PX = 56
const ROW_MIN_PX = 24
/** `gap-5` between the parts stacked inside one row's wrapper. The identical gap
 *  BETWEEN rows is the virtualizer's `gap` option and must never be added here:
 *  counted in both places every row would sit 20px lower than the one above it. */
export const NATIVE_CHAT_ROW_GAP_PX = 20
// A single row can legitimately be enormous (a pasted file, an open diff). The
// cap only bounds the *estimate*: measurement replaces it as soon as the row
// mounts, and an estimate the size of ten viewports makes the scrollbar useless
// until then.
const ROW_MAX_PX = 1600

/** Wrapped line count for a markdown body, counting hard breaks and soft wraps. */
export function estimateNativeChatTextLines(markdown: string): number {
  if (markdown.length === 0) {
    return 0
  }
  let lines = 0
  let lineStart = 0
  for (let index = 0; index <= markdown.length; index += 1) {
    if (index === markdown.length || markdown[index] === '\n') {
      const length = index - lineStart
      lines += Math.max(PROSE_MIN_LINES, Math.ceil(length / CHARS_PER_LINE))
      lineStart = index + 1
    }
  }
  return lines
}

const metricsCache = new WeakMap<object, NativeChatRowContentMetrics>()

/** Cached on the block array, like the row content it reads, so a streaming turn
 *  re-deriving on every frame pays for the changed row only. */
export function nativeChatRowContentMetrics(
  message: NativeChatMessage
): NativeChatRowContentMetrics {
  const cached = metricsCache.get(message.blocks)
  if (cached) {
    return cached
  }
  const content = deriveNativeChatRowContent(message.blocks)
  const metrics: NativeChatRowContentMetrics = {
    role: message.role,
    textLines: estimateNativeChatTextLines(content.markdown),
    imageCount: content.prose.filter((block) => block.type === 'image-ref').length,
    toolCount: content.tools.length,
    subagentGroupCount: content.subagentGroups.length
  }
  metricsCache.set(message.blocks, metrics)
  return metrics
}

export function estimateNativeChatRowHeight(
  content: NativeChatRowContentMetrics,
  chrome: NativeChatRowChromeMetrics
): number {
  if (chrome.hasReceipt) {
    return RECEIPT_PX + (chrome.hasStatus ? NATIVE_CHAT_ROW_GAP_PX + STATUS_ROW_PX : 0)
  }
  let height = content.textLines * LINE_HEIGHT_PX
  if (content.role === 'user' && content.textLines > 0) {
    height += USER_BUBBLE_CHROME_PX
  }
  if (content.imageCount > 0) {
    height += IMAGE_STRIP_PX
  }
  if (content.toolCount > 0) {
    // A run is one collapsed header by default; its members only exist while open.
    height += TOOL_RUN_PX
  }
  height += content.subagentGroupCount * SUBAGENT_ROW_PX
  if (chrome.hasStatus) {
    height += NATIVE_CHAT_ROW_GAP_PX + STATUS_ROW_PX
  }
  if (chrome.hasTurnDiff) {
    height += NATIVE_CHAT_ROW_GAP_PX + TURN_DIFF_PX
  }
  return Math.min(ROW_MAX_PX, Math.max(ROW_MIN_PX, height))
}

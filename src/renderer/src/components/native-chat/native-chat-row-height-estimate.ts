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
import { deriveNativeChatRowContent } from '../../../../shared/native-chat-row-content'
import {
  NATIVE_CHAT_USER_MESSAGE_FOLDED_PX,
  nativeChatUserMessageFolds
} from './native-chat-user-message-fold'

/** What a row contains, reduced to the few numbers that drive its height. */
export type NativeChatRowContentMetrics = {
  role: NativeChatMessage['role']
  /** Wrapped display lines of prose, not source lines. */
  textLines: number
  /** A user prompt long enough to mount folded behind "Show full message". */
  userFolds: boolean
  imageCount: number
  toolCount: number
  subagentGroupCount: number
}

/** Extras the message itself doesn't know about — they come from the turn. */
export type NativeChatRowChromeMetrics = {
  hasReceipt: boolean
  hasStatus: boolean
  hasTurnDiff: boolean
  /** Behind a folded turn: prose and tool activity draw nothing, so estimating
   *  them would reserve a screen of height for a row that paints a roster. */
  folded?: boolean
  /** Inside a subagent's section, where assistant prose keeps its controls in flow. */
  inSubagentSection?: boolean
}

export type NativeChatRowTypography = {
  lineHeightPx: number
  charsPerLine: number
}
const DEFAULT_ROW_TYPOGRAPHY: NativeChatRowTypography = { lineHeightPx: 22, charsPerLine: 96 }
const PROSE_MIN_LINES = 1
const USER_BUBBLE_CHROME_PX = 32
const USER_FOLD_TOGGLE_PX = 24
const IMAGE_STRIP_PX = 88
/** Header margin and vertical padding; its summary can occupy two text lines. */
const TOOL_RUN_CHROME_PX = 16
/** A reasoning row draws only its one-line trigger (`min-h-6`) until opened; opening remeasures it. */
const COLLAPSED_REASONING_PX = 24
const SUBAGENT_ROW_PX = 32
/** The one-line head that names a subagent above its own rows. */
export const NATIVE_CHAT_SUBAGENT_SECTION_HEAD_PX = SUBAGENT_ROW_PX
const STATUS_ROW_PX = 28
const TURN_DIFF_PX = 28
const RECEIPT_PX = 56
/** How far assistant prose's controls hang below the row (`-mb-5`) outside a section. */
const AGENT_CONTROLS_OVERHANG_PX = 20
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
export function estimateNativeChatTextLines(
  markdown: string,
  charsPerLine = DEFAULT_ROW_TYPOGRAPHY.charsPerLine
): number {
  if (markdown.length === 0) {
    return 0
  }
  let lines = 0
  let lineStart = 0
  for (let index = 0; index <= markdown.length; index += 1) {
    if (index === markdown.length || markdown[index] === '\n') {
      const length = index - lineStart
      lines += Math.max(PROSE_MIN_LINES, Math.ceil(length / charsPerLine))
      lineStart = index + 1
    }
  }
  return lines
}

const metricsCache = new WeakMap<
  NativeChatMessage,
  { charsPerLine: number; metrics: NativeChatRowContentMetrics }
>()

/** Cached on the message, so its role remains part of the identity and a streaming turn
 *  re-deriving on every frame pays for the changed row only. */
export function nativeChatRowContentMetrics(
  message: NativeChatMessage,
  typography = DEFAULT_ROW_TYPOGRAPHY
): NativeChatRowContentMetrics {
  const cached = metricsCache.get(message)
  if (cached?.charsPerLine === typography.charsPerLine) {
    return cached.metrics
  }
  const content = deriveNativeChatRowContent(message.blocks)
  const metrics: NativeChatRowContentMetrics = {
    role: message.role,
    textLines: estimateNativeChatTextLines(content.markdown, typography.charsPerLine),
    userFolds: message.role === 'user' && nativeChatUserMessageFolds(content.markdown),
    imageCount: content.prose.filter((block) => block.type === 'image-ref').length,
    toolCount: content.tools.length,
    subagentGroupCount: content.subagentGroups.length
  }
  metricsCache.set(message, { charsPerLine: typography.charsPerLine, metrics })
  return metrics
}

/** A collapsed work run: a lead head's own words over one tool-run header. Its thoughts draw
 *  only once it opens, which remeasures it. */
export function nativeChatWorkRunContentMetrics(
  head: NativeChatRowContentMetrics,
  headIsLead: boolean
): NativeChatRowContentMetrics {
  return {
    role: 'assistant',
    textLines: headIsLead ? head.textLines : 0,
    userFolds: false,
    imageCount: headIsLead ? head.imageCount : 0,
    toolCount: 1,
    subagentGroupCount: 0
  }
}

/** The trigger's headline is chat text, so it grows with the chat size above its `min-h-6` floor. */
function collapsedReasoningHeight(typography: NativeChatRowTypography): number {
  return Math.max(
    COLLAPSED_REASONING_PX,
    (COLLAPSED_REASONING_PX * typography.lineHeightPx) / DEFAULT_ROW_TYPOGRAPHY.lineHeightPx
  )
}

export function estimateNativeChatRowHeight(
  content: NativeChatRowContentMetrics,
  chrome: NativeChatRowChromeMetrics,
  typography = DEFAULT_ROW_TYPOGRAPHY
): number {
  let partCount = 0
  let height = 0
  if (chrome.hasReceipt) {
    height = RECEIPT_PX
    partCount = 1
  } else if (chrome.folded === true) {
    height = content.subagentGroupCount * SUBAGENT_ROW_PX
    partCount = height > 0 ? 1 : 0
  } else {
    height =
      content.role === 'reasoning'
        ? content.textLines > 0
          ? collapsedReasoningHeight(typography)
          : 0
        : content.userFolds
          ? NATIVE_CHAT_USER_MESSAGE_FOLDED_PX + USER_FOLD_TOGGLE_PX
          : content.textLines * typography.lineHeightPx
    if (content.role === 'user' && content.textLines > 0) {
      height += USER_BUBBLE_CHROME_PX
    }
    if (
      chrome.inSubagentSection === true &&
      content.role === 'assistant' &&
      content.textLines > 0
    ) {
      height += AGENT_CONTROLS_OVERHANG_PX
    }
    if (content.imageCount > 0) {
      height += IMAGE_STRIP_PX
    }
    if (content.toolCount > 0) {
      // A run is one collapsed header by default; its members only exist while open.
      height += TOOL_RUN_CHROME_PX + 2 * typography.lineHeightPx
    }
    height += content.subagentGroupCount * SUBAGENT_ROW_PX
    partCount = height > 0 ? 1 : 0
  }
  if (chrome.hasStatus) {
    height += STATUS_ROW_PX
    partCount += 1
  }
  if (chrome.hasTurnDiff) {
    height += TURN_DIFF_PX
    partCount += 1
  }
  height += Math.max(0, partCount - 1) * NATIVE_CHAT_ROW_GAP_PX
  return Math.min(ROW_MAX_PX, Math.max(ROW_MIN_PX, height))
}

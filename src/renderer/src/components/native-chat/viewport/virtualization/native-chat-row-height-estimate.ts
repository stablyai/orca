import { nativeChatProseToMarkdown } from '../../../../../../shared/native-chat/transcript/native-chat-prose'
// Keep estimates arithmetic over cached metrics; per-measurement block scans would traverse the whole transcript.

import { NATIVE_CHAT_TURN_DIFF_FILE_LIMIT } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { agentMessageIsCompact } from '../../../../../../shared/agent-session/agent-message-presentation'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/native-chat-row-content'
import {
  NATIVE_CHAT_USER_MESSAGE_FOLDED_PX,
  nativeChatUserMessageFolds
} from '../../../../../../shared/native-chat/transcript/native-chat-user-message-fold'

export type NativeChatRowContentMetrics = {
  role: NativeChatMessage['role']
  compactAgentMessage?: boolean
  /** Wrapped display lines of prose, not source lines. */
  textLines: number
  /** A user prompt long enough to mount folded behind "Show full message". */
  userFolds: boolean
  imageCount: number
  toolCount: number
  subagentGroupCount: number
}

export type NativeChatRowChromeMetrics = {
  hasReceipt: boolean
  hasStatus: boolean
  hasTurnDiff: boolean
  turnDiffFileCount?: number
  openedPullRequestCount?: number
  /** Folded prose/tools paint only a roster and must not reserve their expanded height. */
  folded?: boolean
  /** Inside a subagent's section, where assistant prose keeps its controls in flow. */
  inSubagentSection?: boolean
}

export type NativeChatRowTypography = {
  lineHeightPx: number
  charsPerLine: number
  /** Spacing and controls relative to the default; bounded separately from message text. */
  spacingScale: number
}
export const DEFAULT_ROW_TYPOGRAPHY: NativeChatRowTypography = {
  lineHeightPx: 22,
  charsPerLine: 96,
  spacingScale: 1
}
const PROSE_MIN_LINES = 1
const USER_BUBBLE_CHROME_PX = 32
const USER_FOLD_TOGGLE_PX = 24
const IMAGE_STRIP_PX = 88
/** Header margin and vertical padding; its summary can occupy two text lines. */
const TOOL_RUN_CHROME_PX = 16
/** A reasoning row draws only its one-line trigger (`min-h-6`) until opened; opening remeasures it. */
const COLLAPSED_REASONING_PX = 24
const COMPACT_AGENT_MESSAGE_PX = 38
const SUBAGENT_ROW_PX = 32
export const NATIVE_CHAT_SUBAGENT_SECTION_HEAD_PX = SUBAGENT_ROW_PX
const STATUS_ROW_PX = 28
const TURN_DIFF_PX = 28
/** The opened-PR card: its heading, then one row per pull request. */
const OPENED_PULL_REQUEST_ROW_PX = 30
const RECEIPT_PX = 56
/** How far assistant prose's controls hang below the row (`-mb-5`) outside a section. */
const AGENT_CONTROLS_OVERHANG_PX = 20
const ROW_MIN_PX = 24
/** Charge internal gap-5 only; the virtualizer owns inter-row gaps, which would otherwise compound drift. */
export const NATIVE_CHAT_ROW_GAP_PX = 20
// Cap estimates to keep scrolling usable; mounted measurements may legitimately exceed this limit.
const ROW_MAX_PX = 1600

export function estimateNativeChatTextLines(
  markdown: string,
  charsPerLine = DEFAULT_ROW_TYPOGRAPHY.charsPerLine,
  maxLines = Number.POSITIVE_INFINITY
): number {
  if (markdown.length === 0) {
    return 0
  }
  let lines = 0
  let lineStart = 0
  const length = Math.min(markdown.length, Math.ceil(maxLines * Math.max(1, charsPerLine)))
  for (let index = 0; index <= length; index += 1) {
    if (index === length || markdown.charCodeAt(index) === 10) {
      const length = index - lineStart
      lines += Math.max(PROSE_MIN_LINES, Math.ceil(length / charsPerLine))
      lineStart = index + 1
      if (lines >= maxLines) {
        return maxLines
      }
    }
  }
  return lines
}

const metricsCache = new WeakMap<
  NativeChatMessage,
  { charsPerLine: number; lineHeightPx: number; metrics: NativeChatRowContentMetrics }
>()

/** Cache per message identity so streaming rederives metrics only for changed rows. */
export function nativeChatRowContentMetrics(
  message: NativeChatMessage,
  typography = DEFAULT_ROW_TYPOGRAPHY
): NativeChatRowContentMetrics {
  const cached = metricsCache.get(message)
  if (
    cached?.charsPerLine === typography.charsPerLine &&
    cached.lineHeightPx === typography.lineHeightPx
  ) {
    return cached.metrics
  }
  const content = deriveNativeChatRowContent(message.blocks)
  const maxLines = Math.ceil(ROW_MAX_PX / typography.lineHeightPx)
  const markdown = nativeChatProseToMarkdown(
    content.prose,
    Math.max(601, Math.ceil(maxLines * Math.max(1, typography.charsPerLine)))
  )
  const metrics: NativeChatRowContentMetrics = {
    role: message.role,
    compactAgentMessage: agentMessageIsCompact(message),
    textLines: estimateNativeChatTextLines(markdown, typography.charsPerLine, maxLines),
    userFolds: message.role === 'user' && nativeChatUserMessageFolds(markdown),
    imageCount: content.prose.filter((block) => block.type === 'image-ref').length,
    toolCount: content.tools.length,
    subagentGroupCount: content.subagentGroups.length
  }
  metricsCache.set(message, {
    charsPerLine: typography.charsPerLine,
    lineHeightPx: typography.lineHeightPx,
    metrics
  })
  return metrics
}

/** Collapsed work runs show the lead text and one header; opening thoughts triggers remeasurement. */
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

export function estimateNativeChatRowHeight(
  content: NativeChatRowContentMetrics,
  chrome: NativeChatRowChromeMetrics,
  typography = DEFAULT_ROW_TYPOGRAPHY
): number {
  const scale = typography.spacingScale
  let partCount = 0
  let height = 0
  if (chrome.hasReceipt) {
    height = RECEIPT_PX * scale
    partCount = 1
  } else if (chrome.folded === true) {
    height = content.subagentGroupCount * SUBAGENT_ROW_PX * scale
    partCount = height > 0 ? 1 : 0
  } else if (content.compactAgentMessage) {
    height = COMPACT_AGENT_MESSAGE_PX * scale
    partCount = 1
  } else {
    height =
      content.role === 'reasoning'
        ? content.textLines > 0
          ? COLLAPSED_REASONING_PX * scale
          : 0
        : content.userFolds
          ? (NATIVE_CHAT_USER_MESSAGE_FOLDED_PX + USER_FOLD_TOGGLE_PX) * scale
          : content.textLines * typography.lineHeightPx
    if (content.role === 'user' && content.textLines > 0) {
      height += USER_BUBBLE_CHROME_PX * scale
    }
    if (
      chrome.inSubagentSection === true &&
      content.role === 'assistant' &&
      content.textLines > 0
    ) {
      height += AGENT_CONTROLS_OVERHANG_PX * scale
    }
    if (content.imageCount > 0) {
      height += IMAGE_STRIP_PX * scale
    }
    if (content.toolCount > 0) {
      // A run is one collapsed header by default; its members only exist while open.
      height += TOOL_RUN_CHROME_PX * scale + 2 * typography.lineHeightPx
    }
    height += content.subagentGroupCount * SUBAGENT_ROW_PX * scale
    partCount = height > 0 ? 1 : 0
  }
  if (chrome.hasStatus) {
    height += STATUS_ROW_PX * scale
    partCount += 1
  }
  if (chrome.hasTurnDiff) {
    height +=
      TURN_DIFF_PX *
      scale *
      (1 +
        Math.min(chrome.turnDiffFileCount ?? 0, NATIVE_CHAT_TURN_DIFF_FILE_LIMIT) +
        (chrome.turnDiffFileCount !== undefined &&
        chrome.turnDiffFileCount > NATIVE_CHAT_TURN_DIFF_FILE_LIMIT
          ? 1
          : 0))
    partCount += 1
  }
  if (chrome.openedPullRequestCount) {
    height += OPENED_PULL_REQUEST_ROW_PX * scale * (1 + chrome.openedPullRequestCount)
    partCount += 1
  }
  height += Math.max(0, partCount - 1) * NATIVE_CHAT_ROW_GAP_PX
  return Math.min(ROW_MAX_PX, Math.max(ROW_MIN_PX, height))
}

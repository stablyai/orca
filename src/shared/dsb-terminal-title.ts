import {
  CLAUDE_IDLE,
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING,
  containsAgentSpinnerGlyph
} from './agent-title-glyphs'
import { isDshTerminalTitle } from './dsh-terminal-title'
import type { AgentStatus } from './agent-title-core'
import { getWrapperTitleSegments } from './terminal-title-wrapper-segments'

const DSB_TITLE_RE = /(?:^| - )deepseek build$/i
// Why: DSB separates its spinner with " - "; a Claude task can end on the same suffix.
const DSB_WORKING_TITLE_RE =
  /^(?:⚠ Action Required - )?[\u2800-\u28ff]+\s+-\s+[\s\S]+?\s-\s+deepseek build$/i
const NATIVE_VENDOR_PREFIXES = [
  `${CLAUDE_IDLE} `,
  '. ',
  '* ',
  GEMINI_IDLE,
  GEMINI_PERMISSION,
  GEMINI_SILENT_WORKING,
  GEMINI_WORKING
]

export function isDeepSeekBuildTerminalTitle(title: string): boolean {
  const segments = getWrapperTitleSegments(title.trim())
  // Why: native owner markers must win even inside a wrapper; task glyphs are not markers.
  if (
    segments.some(
      (segment) =>
        isDshTerminalTitle(segment) ||
        NATIVE_VENDOR_PREFIXES.some((prefix) => segment.startsWith(prefix))
    )
  ) {
    return false
  }
  return segments.some(
    (segment) =>
      DSB_TITLE_RE.test(segment) &&
      (!containsAgentSpinnerGlyph(segment) || DSB_WORKING_TITLE_RE.test(segment))
  )
}

export function getDeepSeekBuildTitleStatus(title: string): AgentStatus | null {
  if (!isDeepSeekBuildTerminalTitle(title)) {
    return null
  }
  const segments = getWrapperTitleSegments(title.trim())
  if (segments.some((segment) => segment.startsWith('⚠ Action Required - '))) {
    return 'permission'
  }
  return segments.some((segment) => DSB_WORKING_TITLE_RE.test(segment)) ? 'working' : 'idle'
}

import { detectAgentStatusFromTitle, MAX_OSC_TITLE_CHARS } from './agent-detection'

export const DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT = MAX_OSC_TITLE_CHARS

export function getDecorativeAgentTitleSignature(title: string): string | null {
  // Why: this runs on renderer state/session hot paths; oversized titles are
  // treated as ordinary changes instead of synchronously normalized.
  if (title.length > DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT) {
    return null
  }
  const status = detectAgentStatusFromTitle(title)
  if (!status) {
    return null
  }
  // Why: agent spinners can emit OSC title frames many times per second; the
  // spinner glyph is live decoration, not meaningful tab or sort state.
  return `${status}:${normalizeDecorativeAgentTitleText(title)}`
}

export function isDecorativeAgentTitleFrameChange(prevTitle: string, nextTitle: string): boolean {
  const prevSignature = getDecorativeAgentTitleSignature(prevTitle)
  return prevSignature !== null && prevSignature === getDecorativeAgentTitleSignature(nextTitle)
}

function normalizeDecorativeAgentTitleText(title: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index)
    if (normalized.length === 0 && (isDecorativeTitleWhitespace(code) || isBrailleSpinner(code))) {
      continue
    }
    if (isDecorativeTitleWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += title.charAt(index)
  }
  return normalized
}

function isBrailleSpinner(code: number): boolean {
  return code >= 0x2800 && code <= 0x28ff
}

function isDecorativeTitleWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

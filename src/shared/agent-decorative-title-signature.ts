import { detectAgentStatusFromTitle, MAX_OSC_TITLE_CHARS } from './agent-detection'

export const DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT = MAX_OSC_TITLE_CHARS

export function getDecorativeAgentTitleSignature(title: string): string | null {
  // Bound synchronous normalization on renderer hot paths; oversized titles remain ordinary changes.
  if (title.length > DECORATIVE_AGENT_TITLE_SIGNATURE_SOURCE_SCAN_LIMIT) {
    return null
  }
  const status = detectAgentStatusFromTitle(title)
  if (!status) {
    return null
  }
  // Spinner OSC frames can arrive many times a second without changing semantic title/sort state.
  return `${status}:${normalizeDecorativeAgentTitleText(title)}`
}

/** Equal keys mean the title changed only by spinner decoration. */
export function getDecorativeTitleGateKey(rawTitle: string, normalizedTitle: string): string {
  // Stable Pi/Gemini/Grok display normalization also defines their semantic gate.
  const normalizedSignature =
    rawTitle === normalizedTitle ? null : getDecorativeAgentTitleSignature(normalizedTitle)
  const signature = normalizedSignature ?? getDecorativeAgentTitleSignature(rawTitle)
  return signature === null ? `literal\u0000${normalizedTitle}` : `agent\u0000${signature}`
}

export function isDecorativeAgentTitleFrameChange(prevTitle: string, nextTitle: string): boolean {
  const prevSignature = getDecorativeAgentTitleSignature(prevTitle)
  return prevSignature !== null && prevSignature === getDecorativeAgentTitleSignature(nextTitle)
}

function normalizeDecorativeAgentTitleText(title: string): string {
  let normalized = ''
  let pendingWhitespace = false
  let leadingFrame = -1
  for (let index = 0; index < title.length; index += 1) {
    const code = title.charCodeAt(index)
    if (
      normalized.length === 0 &&
      (isDecorativeTitleWhitespace(code) || isSpinnerFrameGlyph(code))
    ) {
      if (leadingFrame === -1 && isSpinnerFrameGlyph(code)) {
        leadingFrame = code
      }
      continue
    }
    // Why: Codex repeats its leading frame as a word inside the title (`⠙ renaming... ⠙ |
    // scratch`), so that copy folds like whitespace too; other braille stays title text.
    if (
      isDecorativeTitleWhitespace(code) ||
      (code === leadingFrame && isStandaloneGlyph(title, index))
    ) {
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

function isStandaloneGlyph(title: string, index: number): boolean {
  const next = index + 1 < title.length ? title.charCodeAt(index + 1) : null
  return (
    isDecorativeTitleWhitespace(title.charCodeAt(index - 1)) &&
    (next === null || isDecorativeTitleWhitespace(next))
  )
}

// Why: braille (most agents) plus quarter circles (Claude Code 2.1.228+, #13889).
function isSpinnerFrameGlyph(code: number): boolean {
  return (code >= 0x2800 && code <= 0x28ff) || (code >= 0x25d0 && code <= 0x25d3)
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

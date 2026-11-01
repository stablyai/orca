export const GENERATED_TAB_TITLE_MAX_LENGTH = 40
export const GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT = 512

/**
 * True when the tab's generated title came from a session the pane has left, so
 * it names a finished conversation. Unknown on either side is not proof — keep it.
 *
 * Known limitation: `--resume`/`--continue` fork the session id for the SAME
 * conversation, and nothing in the hook payload distinguishes a fork from a fresh
 * `/clear`, so a resume retitles the tab once. TODO: compare against the fork
 * lineage from the daemon roster (#9236) instead of plain id inequality.
 */
export function generatedTitleNamesEndedSession(
  tab: { generatedTitleSessionId?: string | null },
  liveSessionId: string | undefined
): boolean {
  const titleSessionId = tab.generatedTitleSessionId?.trim()
  const liveId = liveSessionId?.trim()
  return Boolean(titleSessionId && liveId) && titleSessionId !== liveId
}

const LEADING_FILLER_PATTERNS: RegExp[] = [
  /^(?:can|could|would)\s+you(?:\s+please)?\s+/i,
  /^please(?:\s+|$)/i,
  /^i\s+(?:want|need)\s+(?:you\s+)?to\s+/i,
  /^help\s+me(?:\s+to)?\s+/i,
  /^help\s+/i,
  /^let'?s\s+/i,
  /^we\s+need\s+to\s+/i,
  /^need\s+to\s+/i
]

function capitalizeFirstLetter(value: string): string {
  return value.replace(/\p{L}/u, (letter) => letter.toLocaleUpperCase())
}

function truncateAtWordBoundary(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  const rawSlice = value.slice(0, maxLength)
  const sliced = rawSlice.trim()
  if (sliced.length < rawSlice.length) {
    return sliced
  }
  const lastSpace = sliced.lastIndexOf(' ')
  if (lastSpace >= Math.floor(maxLength * 0.55)) {
    return sliced.slice(0, lastSpace).trim()
  }
  return sliced
}

// Collapse pasted-prompt whitespace without a regex pass on renderer state paths.
function foldGeneratedTabTitleWhitespace(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isGeneratedTabTitleWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index)
  }
  return normalized
}

function isGeneratedTabTitleWhitespace(code: number): boolean {
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

export function deriveGeneratedTabTitle(prompt: string): string | null {
  // Bound renderer title cleanup before scanning paste-sized prompts.
  const promptPreview = prompt.slice(0, GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT)
  const firstClause = promptPreview
    .trim()
    // Strip URLs before punctuation: underscores in /merge_requests would leak fragments. Avoid a word boundary so _https://…_ also matches.
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[`*_~#>[\]{}()]/g, ' ')
    .replace(/^(?:issue|task|bug|feature|pr)\s*(?:#?\d+)?\s*[:-]\s*/i, '')
    .split(/[.!?;\n\r\u2028\u2029]/u)[0]
    ?.trim()

  if (!firstClause) {
    return null
  }

  let candidate = firstClause
  for (let i = 0; i < 3; i += 1) {
    const before = candidate
    for (const pattern of LEADING_FILLER_PATTERNS) {
      candidate = candidate.replace(pattern, '')
    }
    candidate = candidate.trim()
    if (candidate === before.trim()) {
      break
    }
  }

  candidate = foldGeneratedTabTitleWhitespace(candidate.replace(/[^\p{L}\p{N}\s]/gu, ' '))

  if (!candidate) {
    return null
  }

  return truncateAtWordBoundary(capitalizeFirstLetter(candidate), GENERATED_TAB_TITLE_MAX_LENGTH)
}

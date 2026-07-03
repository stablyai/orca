export const GENERATED_TAB_TITLE_MAX_LENGTH = 40
export const GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT = 512

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

// Why: generated titles are derived from pasted agent prompts on renderer
// state paths; collapse display whitespace without a regex replacement pass.
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
  // Why: agent prompts can be paste-sized. Generated tab titles are previews,
  // so title cleanup must not scan the full prompt on the renderer state path.
  const promptPreview = prompt.slice(0, GENERATED_TAB_TITLE_SOURCE_SCAN_LIMIT)
  const firstClause = promptPreview
    .trim()
    .replace(/[`*_~#>[\]{}()]/g, ' ')
    .replace(/^(?:issue|task|bug|feature|pr)\s*(?:#?\d+)?\s*[:-]\s*/i, '')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
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

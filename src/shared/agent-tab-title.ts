export const GENERATED_TAB_TITLE_MAX_LENGTH = 40

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

export function deriveGeneratedTabTitle(prompt: string): string | null {
  const firstClause = prompt
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

  candidate = candidate
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!candidate) {
    return null
  }

  return truncateAtWordBoundary(capitalizeFirstLetter(candidate), GENERATED_TAB_TITLE_MAX_LENGTH)
}

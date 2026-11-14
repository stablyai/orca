import { resolveTerminalFileUrlTarget } from './terminal-file-url-target'
import type { ParsedTerminalFileLink } from './terminal-links'

// Share OSC 8 resolution for plain file URIs missed by HTTP/local-path detectors.

const MAX_FILE_URI_LENGTH = 2048
// Bound file URI candidates before URL parsing/filesystem probes so dumped tokens cannot stall hover.
const FILE_URI_REGEX = /\bfile:\/\/[^\s"`<>|]{1,2049}/gi

const TRAILING_PROSE_CHARS = new Set(['.', ',', ';', ':', '!', '?', '>', '"', "'", '`'])

function trimTrailingProse(uriText: string): string {
  let parentheses = 0
  let brackets = 0
  let braces = 0
  for (const char of uriText) {
    parentheses += char === ')' ? 1 : char === '(' ? -1 : 0
    brackets += char === ']' ? 1 : char === '[' ? -1 : 0
    braces += char === '}' ? 1 : char === '{' ? -1 : 0
  }

  let end = uriText.length
  while (end > 0) {
    const char = uriText[end - 1]
    if (TRAILING_PROSE_CHARS.has(char)) {
      end -= 1
      continue
    }
    // Preserve balanced filename parentheses; trim only unmatched prose closers from standard unescaped file URIs.
    if (char === ')' && parentheses > 0) {
      parentheses -= 1
      end -= 1
      continue
    }
    if (char === ']' && brackets > 0) {
      brackets -= 1
      end -= 1
      continue
    }
    if (char === '}' && braces > 0) {
      braces -= 1
      end -= 1
      continue
    }
    break
  }
  return uriText.slice(0, end)
}

// Reject remote hostnames in this platform-free pass; local probes cannot resolve them. OSC handling retains Windows UNC support with its platform context.
function toFileUriLink(uriText: string, startIndex: number): ParsedTerminalFileLink | null {
  let url: URL
  try {
    url = new URL(uriText)
  } catch {
    return null
  }
  const target = resolveTerminalFileUrlTarget(url)
  if (!target) {
    return null
  }
  return {
    pathText: target.filePath,
    line: target.line,
    column: target.column,
    startIndex,
    endIndex: startIndex + uriText.length,
    displayText: uriText
  }
}

export function detectTerminalFileUriLinks(lineText: string): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  for (const match of lineText.matchAll(FILE_URI_REGEX)) {
    const startIndex = match.index ?? 0
    if (match[0].length > MAX_FILE_URI_LENGTH) {
      continue
    }
    const trimmed = trimTrailingProse(match[0])
    if (!trimmed) {
      continue
    }
    const link = toFileUriLink(trimmed, startIndex)
    if (link) {
      links.push(link)
    }
  }
  return links
}

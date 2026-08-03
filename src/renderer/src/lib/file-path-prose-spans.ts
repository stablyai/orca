import { extractTerminalFileLinks, type ParsedTerminalFileLink } from './terminal-links'

// File-path spans inside a prose run, reusing the desktop terminal detector.
//
// Two terminal affordances do not survive the move to prose, and both are
// disabled here rather than inherited:
//
//   - Bare filenames. The terminal decorates a span only after a hover
//     existence probe, so an unbacked guess costs nothing. Chat styles at
//     detection time, so "1.2.3" or "Node.js" would become a visible dead link.
//   - Spaced paths. "/tmp/My Project/a.ts" is resolvable in a terminal because
//     the tapped column picks among candidates; in prose there is no column, and
//     a greedy match swallows the words between two paths ("a.ts and b.ts").
//
// So prose scans whitespace-delimited tokens and requires the detector to claim
// a whole token, with a separator in it.

// A prose run long enough to hold a path is short; the cap bounds scanning on
// pathological input.
const MAX_PROSE_LENGTH = 2000

const TOKEN_PATTERN = /\S+/g

const LEADING_PUNCTUATION = /^[{<'"`]+/
// A trailing ':' or '.' is prose punctuation; a ':12:7' suffix ends in a digit
// and is left intact.
const TRAILING_PUNCTUATION = /[}>'"`,.;:!?]+$/

type ProseToken = {
  text: string
  offset: number
}

function hasBalancedDelimiter(value: string, open: string, close: string): boolean {
  let depth = 0
  for (const char of value) {
    if (char === open) {
      depth += 1
    } else if (char === close && --depth < 0) {
      return false
    }
  }
  return depth === 0
}

function hasBalancedRouteDelimiters(value: string): boolean {
  return hasBalancedDelimiter(value, '(', ')') && hasBalancedDelimiter(value, '[', ']')
}

function trimProsePunctuation(token: string, offset: number): ProseToken {
  const leading = LEADING_PUNCTUATION.exec(token)?.[0].length ?? 0
  const withoutLeading = token.slice(leading)
  const trailing = TRAILING_PUNCTUATION.exec(withoutLeading)?.[0].length ?? 0
  let text = trailing > 0 ? withoutLeading.slice(0, -trailing) : withoutLeading
  let wrapperLength = 0
  while (
    ((text.startsWith('(') && text.endsWith(')')) ||
      (text.startsWith('[') && text.endsWith(']'))) &&
    hasBalancedRouteDelimiters(text.slice(1, -1))
  ) {
    text = text.slice(1, -1)
    wrapperLength += 1
  }
  while (!hasBalancedRouteDelimiters(text)) {
    const withoutTrailing = text.slice(0, -1)
    if ((text.endsWith(')') || text.endsWith(']')) && hasBalancedRouteDelimiters(withoutTrailing)) {
      text = withoutTrailing
      continue
    }
    break
  }
  return {
    text,
    offset: offset + leading + wrapperLength
  }
}

// "example.com/foo", "docs.rs/serde", "github.com/a/b" all clear the separator
// rule, so a bare domain needs its own check. Matching the whole first segment
// keeps ".github/workflows/ci.yml" (leading dot, no name before it) and
// "v1.2/out.ts" (numeric tail) out of this net.
const DOMAIN_LIKE_SEGMENT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i

function hasDomainLikeFirstSegment(pathText: string): boolean {
  // Absolute, tilde, explicit-relative and drive-letter paths cannot be a domain.
  if (/^(?:[\\/~]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/.test(pathText)) {
    return false
  }
  return DOMAIN_LIKE_SEGMENT.test(pathText.split(/[\\/]/)[0] ?? '')
}

function isProsePathSpan(span: ParsedTerminalFileLink): boolean {
  if (!/[\\/]/.test(span.pathText)) {
    return false
  }
  // A scheme-bearing token is a web link; the anchor path already handles those.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(span.pathText)) {
    return false
  }
  if (hasDomainLikeFirstSegment(span.pathText)) {
    return false
  }
  return true
}

export function extractFilePathProseSpans(text: string): ParsedTerminalFileLink[] {
  if (!text || text.length > MAX_PROSE_LENGTH) {
    return []
  }

  const spans: ParsedTerminalFileLink[] = []
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = trimProsePunctuation(match[0], match.index)
    if (!token.text) {
      continue
    }
    // Require the detector to claim the entire token: a partial match means the
    // token is prose that merely contains something path-shaped.
    const claimed = extractTerminalFileLinks(token.text).find(
      (span) => span.startIndex === 0 && span.endIndex === token.text.length
    )
    if (!claimed || !isProsePathSpan(claimed)) {
      continue
    }
    spans.push({
      ...claimed,
      startIndex: token.offset,
      endIndex: token.offset + token.text.length
    })
  }
  return spans
}

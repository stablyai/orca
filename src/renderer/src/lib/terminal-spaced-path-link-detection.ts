import {
  detectTerminalFileLinkRanges,
  insertTerminalFileLinkClaimedRange,
  terminalFileLinkRangesOverlap,
  toParsedTerminalFileLink,
  type DetectedTerminalFileLinkRange
} from './terminal-file-link-detection-ranges'
import type { ParsedTerminalFileLink } from './terminal-links'
import { isInsideUriScheme } from './terminal-uri-scheme-boundary'

// Matches separator paths whose file or folder names include spaces. This runs
// before LOCAL_PATH_REGEX so `/Users/A/Foo Bar/file.ts` is claimed as one link
// instead of split into `/Users/A/Foo` and `Bar/file.ts`.
// Why this is intentionally broad: validating "space followed by a later
// separator" inside the regex creates overlapping whitespace backtracking on
// large ConPTY TUI lines. Keep the scan linear and filter candidates in code.
const SPACED_PATH_WITH_SEPARATOR_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// Why this shares the broad candidate shape: extension paths with prose after
// them still need trimming, but the whitespace/extension test stays in code.
const SPACED_PATH_WITH_EXTENSION_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
// Why this is also broad: the candidates path runs on hover, including huge
// space-padded TUI lines, so reject line-ending spaced paths outside the regex.
const LINE_ENDING_SPACED_PATH_REGEX =
  /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|`\r\n]+(?::\d+)?(?::\d+)?/g
const SPACED_LOCAL_PATH_REGEXES = [
  SPACED_PATH_WITH_SEPARATOR_REGEX,
  SPACED_PATH_WITH_EXTENSION_REGEX,
  LINE_ENDING_SPACED_PATH_REGEX
]

function hasSeparatorAfterWhitespace(text: string): boolean {
  let sawWhitespace = false
  for (const char of text) {
    if (/\s/.test(char)) {
      sawWhitespace = true
      continue
    }
    if (sawWhitespace && (char === '/' || char === '\\')) {
      return true
    }
  }
  return false
}

function hasInternalWhitespaceBeforeTrimmedEnd(text: string): boolean {
  const trimmed = text.trimEnd()
  return /\s/.test(trimmed)
}

function isAtTrimmedLineEnd(lineText: string, endIndex: number): boolean {
  return lineText.slice(endIndex).trim().length === 0
}

function hasSpacedPathExtension(text: string): boolean {
  const trimmedRange = trimSpacedPathTrailingProse({
    text,
    startIndex: 0,
    endIndex: text.length
  })
  const trimmedText = trimmedRange?.text.trimEnd() ?? ''
  return /\s/.test(trimmedText) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmedText)
}

function trimSpacedPathTrailingProse(
  range: DetectedTerminalFileLinkRange
): DetectedTerminalFileLinkRange | null {
  // Why: keep one extension-terminated path, but drop trailing prose or a
  // second unrelated path that the broad spaced-path scan also captured. A
  // line-end extension token only extends the span when the added segment is
  // path-like (contains a separator) — "v1.2 reports/result.json" extends,
  // prose like "failed to start app.py" must not be swallowed.
  let selected: string | null = null
  const extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g
  const pathStartPattern = /(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g
  let pathStartCount = 0
  let nextPathStart = pathStartPattern.exec(range.text)
  let match: RegExpExecArray | null
  while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    const text = range.text.slice(0, end)
    while (nextPathStart && nextPathStart.index + nextPathStart[0].length <= end) {
      pathStartCount += 1
      nextPathStart = pathStartPattern.exec(range.text)
    }
    if (pathStartCount > 1) {
      continue
    }
    if (
      end < range.text.length ||
      selected === null ||
      /[\\/]/.test(range.text.slice(selected.length, end))
    ) {
      selected = text
    }
  }
  if (!selected) {
    // Why: only the reject path needs the whole range's count, so finish the
    // lazy path-start scan here rather than rescanning the text eagerly.
    while (nextPathStart && pathStartCount <= 1) {
      pathStartCount += 1
      nextPathStart = pathStartPattern.exec(range.text)
    }
    return pathStartCount > 1 ? null : range
  }
  return {
    text: selected,
    startIndex: range.startIndex,
    endIndex: range.startIndex + selected.length
  }
}

function trimTrailingWhitespace(
  range: DetectedTerminalFileLinkRange
): DetectedTerminalFileLinkRange {
  const text = range.text.trimEnd()
  return {
    text,
    startIndex: range.startIndex,
    endIndex: range.startIndex + text.length
  }
}

function buildLineEndingSpacedPathPrefixRanges(
  range: DetectedTerminalFileLinkRange
): DetectedTerminalFileLinkRange[] {
  const ranges: DetectedTerminalFileLinkRange[] = []
  for (const match of range.text.matchAll(/\s+/g)) {
    const endIndex = match.index ?? 0
    const text = range.text.slice(0, endIndex).trimEnd()
    if (text.includes(' ')) {
      ranges.push({
        text,
        startIndex: range.startIndex,
        endIndex: range.startIndex + text.length
      })
    }
  }
  return ranges.toReversed()
}

export function detectSpacedLocalPathLinks(
  lineText: string,
  includeLineEndingPrefixCandidates = false
): ParsedTerminalFileLink[] {
  const links: ParsedTerminalFileLink[] = []
  const claimedRanges: [number, number][] = []
  for (const regex of SPACED_LOCAL_PATH_REGEXES) {
    for (const range of detectTerminalFileLinkRanges(lineText, regex)) {
      if (regex === SPACED_PATH_WITH_SEPARATOR_REGEX && !hasSeparatorAfterWhitespace(range.text)) {
        continue
      }
      if (regex === SPACED_PATH_WITH_EXTENSION_REGEX && !hasSpacedPathExtension(range.text)) {
        continue
      }
      if (
        regex === LINE_ENDING_SPACED_PATH_REGEX &&
        (!hasInternalWhitespaceBeforeTrimmedEnd(range.text) ||
          !isAtTrimmedLineEnd(lineText, range.endIndex))
      ) {
        continue
      }
      if (
        terminalFileLinkRangesOverlap(range, claimedRanges) ||
        isInsideUriScheme(lineText, range)
      ) {
        continue
      }
      const candidateRanges =
        includeLineEndingPrefixCandidates && regex === LINE_ENDING_SPACED_PATH_REGEX
          ? [range, ...buildLineEndingSpacedPathPrefixRanges(range)]
          : [range]
      const candidateLinks = candidateRanges
        .map((candidateRange) => {
          const trimmedRange = trimSpacedPathTrailingProse(trimTrailingWhitespace(candidateRange))
          return trimmedRange ? toParsedTerminalFileLink(trimmedRange) : null
        })
        .filter((link): link is ParsedTerminalFileLink => link !== null)
      const link = candidateLinks[0]
      if (link) {
        for (const candidateLink of candidateLinks) {
          links.push(candidateLink)
        }
        insertTerminalFileLinkClaimedRange(claimedRanges, [link.startIndex, link.endIndex])
      }
    }
  }
  return links
}

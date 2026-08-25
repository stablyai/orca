import type { DetectedTerminalFileLinkRange } from './terminal-file-link-detection-ranges'

// Why: keep one extension-terminated path, but drop trailing prose or a second
// unrelated path that the broad spaced-path scan also captured. A line-end
// extension token only extends the span when the added segment is path-like
// (contains a separator) — "v1.2 reports/result.json" extends, prose like
// "failed to start app.py" must not be swallowed.
// Also stop before non-ASCII letters so `…/파일.md로 열었습니다` keeps only
// the path after `\p{L}` widening (space-only trim leaves the particle).
const EXTENSION_PREFIX_PATTERN =
  /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$|(?:(?![A-Za-z])\p{L}))/gu

function countPathStarts(text: string): number {
  let count = 0
  for (const match of text.matchAll(/(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g)) {
    void match
    count += 1
  }
  return count
}

export function trimSpacedPathTrailingProse(
  range: DetectedTerminalFileLinkRange
): DetectedTerminalFileLinkRange {
  let selected: string | null = null
  EXTENSION_PREFIX_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EXTENSION_PREFIX_PATTERN.exec(range.text)) !== null) {
    const end = match.index + match[0].length
    const text = range.text.slice(0, end)
    if (countPathStarts(text) > 1) {
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
    return range
  }
  return {
    text: selected,
    startIndex: range.startIndex,
    endIndex: range.startIndex + selected.length
  }
}

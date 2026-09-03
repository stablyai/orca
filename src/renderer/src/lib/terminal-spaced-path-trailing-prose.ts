import type { DetectedTerminalFileLinkRange } from './terminal-file-link-detection-ranges'

// Why: keep one extension-terminated path, but drop trailing prose or a second
// unrelated path that the broad spaced-path scan also captured. A line-end
// extension token only extends the span when the added segment is path-like
// (contains a separator) — "v1.2 reports/result.json" extends, prose like
// "failed to start app.py" must not be swallowed.
// Also stop at non-ASCII: a CJK bracket closes a citation as often as a particle.
const EXTENSION_PREFIX_PATTERN = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$|\P{ASCII})/gu

// A separator plus an alphabetic extension means the span is already a finished
// path; `v1.2` is not, so a numeric tail still extends into `v1.2 reports/x.json`.
const COMPLETE_PATH = /[\\/].*\.[A-Za-z][A-Za-z0-9_+-]*$/

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
    // Why: countPathStarts only sees absolute starts, so two relative paths on one
    // line used to merge into a span that resolves to nothing and killed both.
    if (selected !== null && COMPLETE_PATH.test(selected)) {
      break
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

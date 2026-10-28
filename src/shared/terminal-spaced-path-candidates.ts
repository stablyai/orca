import {
  ROOTED_PATH_START_PATTERN,
  hasPathSeparator,
  trimTerminalPathBoundaryPunctuation,
  type DetectedTerminalFileLinkRange
} from './terminal-file-link-detection-ranges'

// Spaced readings are guesses the host's existence check settles, so no rule predicts where a path ends.
const MAX_SPACED_PATH_WORDS = 10
// Why: the path regex stops at `#&=!`, which spaced folder names (`C# Projects`) may contain.
const PATH_WORD_CONTINUATION_REGEX = /[^\s()[\]{}'",;<>|`]*/y
// One single-spaced word; quotes and brackets end a spaced path.
const SPACED_PATH_WORD_REGEX = / ([^\s()[\]{}'",;<>|`]+)/y
const FILENAME_PATTERN = /\.[\p{L}\p{N}][\p{L}\p{N}\p{M}_+-]*(?::\d+)?(?::\d+)?[.,;:!?]*$/u

/** Rooted: one reading per following word, up to ten; relative: its first filename. `wordEndIndex` ends the path's own word. */
export function growSpacedPathRanges(
  lineText: string,
  path: DetectedTerminalFileLinkRange,
  rawEndIndex: number
): { ranges: DetectedTerminalFileLinkRange[]; wordEndIndex: number } {
  PATH_WORD_CONTINUATION_REGEX.lastIndex = rawEndIndex
  const continuation = PATH_WORD_CONTINUATION_REGEX.exec(lineText)?.[0] ?? ''
  const wordEndIndex = rawEndIndex + continuation.length
  const ranges: DetectedTerminalFileLinkRange[] = []
  // Why: a trimmed closer (`(src/a.ts) now`) ends the path, a URL is a different link, and
  // a word that continues the path past unsupported punctuation (`/tmp/$draft/a.md`) is never one link.
  if (
    /[^.]/.test(lineText.slice(path.endIndex, rawEndIndex)) ||
    continuation.includes('://') ||
    hasPathSeparator(continuation)
  ) {
    return { ranges, wordEndIndex }
  }
  // Why: relative paths come in dense lists (`src/a.ts src/b.ts`), so they grow only to their first filename.
  const relative = !ROOTED_PATH_START_PATTERN.test(path.text)
  if (relative && FILENAME_PATTERN.test(path.text + continuation)) {
    return { ranges, wordEndIndex }
  }
  SPACED_PATH_WORD_REGEX.lastIndex = wordEndIndex
  let match: RegExpExecArray | null
  for (
    let words = 0;
    words < MAX_SPACED_PATH_WORDS &&
    (match = SPACED_PATH_WORD_REGEX.exec(lineText)) !== null &&
    // Why: `./a.ts ./b.ts` names two paths, and a `scheme://` word starts a URL.
    !ROOTED_PATH_START_PATTERN.test(match[1]) &&
    !match[1].includes('://');
    words += 1
  ) {
    const filename = FILENAME_PATTERN.test(match[1])
    if (relative && !filename) {
      continue
    }
    const range = trimTerminalPathBoundaryPunctuation(
      lineText.slice(path.startIndex, SPACED_PATH_WORD_REGEX.lastIndex),
      path.startIndex
    )
    if (range) {
      ranges.push(range)
    }
    if (relative) {
      break
    }
  }
  return { ranges, wordEndIndex }
}

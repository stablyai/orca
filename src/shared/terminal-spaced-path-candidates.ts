export type TerminalPathTextRange = {
  startIndex: number
  endIndex: number
  text: string
}

const LEADING_TRIM_CHARS = new Set(['(', '[', '{', '"', "'"])
const TRAILING_TRIM_CHARS = new Set([')', ']', '}', '"', "'", ',', ';', '.'])

// Spaced paths are guesses the host's existence check settles, so a path is never hidden behind prose joined onto it.
const MAX_SPACED_PATH_WORDS = 10
// Why: the path regex stops at `#&=!`, which spaced folder names (`C# Projects`) may contain.
const PATH_WORD_CONTINUATION_REGEX = /[^\s()[\]{}'",;<>|`]*/y
// One single-spaced word; quotes, brackets and list punctuation end a spaced path.
const SPACED_PATH_WORD_REGEX = / ([^\s()[\]{}'",;<>|`]+)/y
const SPACED_PATH_EXTENSION_PATTERN = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/
const FILENAME_PATTERN = /\.[A-Za-z][A-Za-z0-9_+-]*(?::\d+)?(?::\d+)?$/
export const ROOTED_PATH_START_PATTERN = /^(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/
// List bullets and shell prompt markers (`~/proj $ git status`) separate a path from what follows.
const SEPARATOR_WORD_PATTERN = /^[\u00B7\u2022\u2013\u2014\u2192$%#>\u276F\u279C]+$/
const SENTENCE_END_PATTERN = /[.,;:!?]+$/

export function trimTerminalPathBoundaryPunctuation(
  value: string,
  startIndex: number
): TerminalPathTextRange | null {
  let start = 0
  let end = value.length
  while (start < end && LEADING_TRIM_CHARS.has(value[start])) {
    start += 1
  }
  while (end > start && TRAILING_TRIM_CHARS.has(value[end - 1])) {
    end -= 1
  }
  if (start >= end) {
    return null
  }
  return {
    text: value.slice(start, end),
    startIndex: startIndex + start,
    endIndex: startIndex + end
  }
}

function hasPathSeparator(text: string): boolean {
  return text.includes('/') || text.includes('\\')
}

function hasSpacedPathExtension(text: string): boolean {
  return SPACED_PATH_EXTENSION_PATTERN.test(text.replace(SENTENCE_END_PATTERN, ''))
}

function endsInFilename(text: string): boolean {
  return FILENAME_PATTERN.test(text.replace(SENTENCE_END_PATTERN, ''))
}

/** Extends a path across single spaces until a filename; keeps words that add a separator or extension, or finish the line. */
export function growSpacedPathRanges(
  lineText: string,
  path: TerminalPathTextRange,
  rawEndIndex: number
): TerminalPathTextRange[] {
  // Why: a trimmed closer (`(src/a.ts) now`) ends the path, and so does a filename (`notes.md. It covers and/or`).
  if (/[^.]/.test(lineText.slice(path.endIndex, rawEndIndex)) || endsInFilename(path.text)) {
    return []
  }
  PATH_WORD_CONTINUATION_REGEX.lastIndex = rawEndIndex
  const continuation = PATH_WORD_CONTINUATION_REGEX.exec(lineText)?.[0] ?? ''
  if (endsInFilename(continuation)) {
    return []
  }
  // Why: unrooted text like `a/b c/d` is usually a list of paths, so it may only grow into a filename.
  const rooted = ROOTED_PATH_START_PATTERN.test(path.text)
  SPACED_PATH_WORD_REGEX.lastIndex = rawEndIndex + continuation.length
  const words: { endIndex: number; namesPathPart: boolean }[] = []
  let grownEndIndex = -1
  let match: RegExpExecArray | null
  while (
    words.length < MAX_SPACED_PATH_WORDS &&
    (match = SPACED_PATH_WORD_REGEX.exec(lineText)) !== null &&
    // Why: `./a.ts ./b.ts` names two paths and `a · b` lists two; neither is one spaced path.
    !ROOTED_PATH_START_PATTERN.test(match[1]) &&
    !SEPARATOR_WORD_PATTERN.test(match[1])
  ) {
    const filename = endsInFilename(match[1])
    if (!rooted && hasPathSeparator(match[1]) && !filename) {
      break
    }
    grownEndIndex = SPACED_PATH_WORD_REGEX.lastIndex
    words.push({
      endIndex: grownEndIndex,
      namesPathPart: rooted
        ? hasPathSeparator(match[1]) || hasSpacedPathExtension(match[1])
        : filename
    })
    if (filename) {
      break
    }
  }
  // Why no continuation: `~/proj$ git status` is a prompt, `/Users/a/My Folder` a folder.
  const finishesLine =
    rooted &&
    continuation.length === 0 &&
    grownEndIndex !== -1 &&
    lineText.slice(grownEndIndex).trim().length === 0
  const ranges: TerminalPathTextRange[] = []
  for (const word of words) {
    if (!word.namesPathPart && !finishesLine) {
      continue
    }
    const range = trimTerminalPathBoundaryPunctuation(
      lineText.slice(path.startIndex, word.endIndex),
      path.startIndex
    )
    if (range && !range.text.includes('://')) {
      ranges.push(range)
    }
  }
  return ranges
}

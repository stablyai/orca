import { acceptedMatches } from '../../text/regex-accepted-matches'

// A comment starts a word or follows `;&|(`, and a heredoc's `<<` is never the tail of `<<<`.
function shellReadsMatchHere({ input, index, 0: match }: RegExpExecArray): boolean {
  const before = input[index - 1] ?? '\n'
  if (match === '#') {
    return /[\s;&|(]/u.test(before)
  }
  return !match.startsWith('<<') || before !== '<'
}

/**
 * A shell scan's matches from `pattern`'s lastIndex on; the caller owns `pattern`. The pattern
 * matches a comment as its bare `#` and a redirection without its fd number, and each match here
 * gets them back, so a `#` inside a word or a long digit run is never rescanned.
 */
export function* shellMatches(text: string, pattern: RegExp): Generator<RegExpExecArray> {
  let scannedFrom = pattern.lastIndex
  for (const match of acceptedMatches(text, pattern, shellReadsMatchHere)) {
    if (match[0] === '#') {
      const lineEnd = text.indexOf('\n', match.index)
      const comment = text.slice(match.index, lineEnd === -1 ? text.length : lineEnd)
      // Every group that captured the `#` captured the comment.
      for (let group = 0; group < match.length; group++) {
        if (match[group] === '#') {
          match[group] = comment
        }
      }
      pattern.lastIndex = match.index + comment.length
    } else if (/^[<>]/u.test(match[0]) && !match[0].startsWith('<<')) {
      // An fd number is the digits that start the redirection's word: `2>&1`, but not `foo2>&1`.
      let start = match.index
      while (start > scannedFrom && /\d/u.test(text.charAt(start - 1))) {
        start--
      }
      if (start < match.index && (start === 0 || /\s/u.test(text.charAt(start - 1)))) {
        match[0] = text.slice(start, match.index) + match[0]
        match.index = start
      }
    }
    yield match
    scannedFrom = pattern.lastIndex
  }
}

/** `text.replace(pattern, replace)` for a shell scan. */
export function replaceShellMatches(
  text: string,
  pattern: RegExp,
  replace: (match: RegExpExecArray) => string
): string {
  let replaced = ''
  let from = 0
  for (const match of shellMatches(text, new RegExp(pattern))) {
    replaced += text.slice(from, match.index) + replace(match)
    from = match.index + match[0].length
  }
  return replaced + text.slice(from)
}

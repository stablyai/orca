/**
 * Visits every line of `content` as `[lineStart, lineEnd)` offsets, excluding a
 * trailing `\r`. Return `false` from `visit` to stop early.
 *
 * Why offsets instead of substrings: these scans run over whole editor
 * documents on every content change, and a 600 KB markdown file has ~43k lines
 * — one substring per line was the bulk of their allocation cost.
 */
export function forEachLine(
  content: string,
  visit: (lineStart: number, lineEnd: number, lineNumber: number) => boolean | void
): void {
  let lineStart = 0
  let lineNumber = 1
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content.charCodeAt(index) !== 10) {
      continue
    }
    const lineEnd = index > lineStart && content.charCodeAt(index - 1) === 13 ? index - 1 : index
    if (visit(lineStart, lineEnd, lineNumber) === false) {
      return
    }
    lineStart = index + 1
    lineNumber += 1
  }
}

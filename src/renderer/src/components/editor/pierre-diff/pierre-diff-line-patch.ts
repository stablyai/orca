import { MyersDiffAlgorithm } from 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm.js'
import { formatPatch, type StructuredPatch } from 'diff'

// A replacement consumes two edits; ordinary 5,000-line changes remain exact.
const MAX_LINE_EDITS = 10_000

export function buildPierreLinePatch(
  oldName: string,
  newName: string,
  original: string,
  modified: string,
  ignoreWhitespace: boolean
): string {
  const split = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const oldLines = split(original)
  const newLines = split(modified)
  const hashes = new Map<string, number>()
  const sequence = (lines: string[]) => {
    const values = lines.map((line) => {
      const key = ignoreWhitespace ? line.trim() : line
      let hash = hashes.get(key)
      if (hash === undefined) {
        hash = hashes.size
        hashes.set(key, hash)
      }
      return hash
    })
    return { length: values.length, getElement: (index: number) => values[index] }
  }
  const left = sequence(oldLines)
  const right = sequence(newLines)
  let edits = 0
  const result = new MyersDiffAlgorithm().compute(left, right, {
    isValid: () => ++edits <= MAX_LINE_EDITS
  })
  const hunks: StructuredPatch['hunks'] = []
  const append = (lines: string[], from: number, to: number, prefix: string, output: string[]) => {
    for (let i = from; i < to; i++) {
      const line = lines[i]
      output.push(prefix + (line.endsWith('\n') ? line.slice(0, -1) : line))
      if (!line.endsWith('\n')) {
        output.push('\\ No newline at end of file')
      }
    }
  }
  // Keep fallback deterministic and preserve the common prefix/suffix, including whitespace policy.
  const changes = result.diffs.map(({ seq1Range, seq2Range }) => ({
    oldStart: seq1Range.start,
    oldEnd: seq1Range.endExclusive,
    newStart: seq2Range.start,
    newEnd: seq2Range.endExclusive
  }))
  if (result.hitTimeout && changes.length) {
    const change = changes[0]
    while (
      change.oldStart < change.oldEnd &&
      change.newStart < change.newEnd &&
      left.getElement(change.oldStart) === right.getElement(change.newStart)
    ) {
      change.oldStart++
      change.newStart++
    }
    while (
      change.oldEnd > change.oldStart &&
      change.newEnd > change.newStart &&
      left.getElement(change.oldEnd - 1) === right.getElement(change.newEnd - 1)
    ) {
      change.oldEnd--
      change.newEnd--
    }
  }
  let oldEnd = 0
  let newEnd = 0
  for (const [index, change] of changes.entries()) {
    const previous = hunks.at(-1)
    const merge = previous && index > 0 && change.oldStart - changes[index - 1].oldEnd <= 8
    const fromOld = merge ? oldEnd : Math.max(0, change.oldStart - 4)
    const fromNew = merge ? newEnd : Math.max(0, change.newStart - 4)
    const hunk = merge
      ? previous
      : {
          oldStart: fromOld + 1,
          newStart: fromNew + 1,
          oldLines: 0,
          newLines: 0,
          lines: []
        }
    if (!merge) {
      hunks.push(hunk)
    }
    append(newLines, fromNew, change.newStart, ' ', hunk.lines)
    append(oldLines, change.oldStart, change.oldEnd, '-', hunk.lines)
    append(newLines, change.newStart, change.newEnd, '+', hunk.lines)
    oldEnd = change.oldEnd
    newEnd = change.newEnd
    const next = changes[index + 1]
    if (!next || next.oldStart - oldEnd > 8) {
      const context = Math.min(4, oldLines.length - oldEnd, newLines.length - newEnd)
      append(newLines, newEnd, newEnd + context, ' ', hunk.lines)
      oldEnd += context
      newEnd += context
    }
    hunk.oldLines = oldEnd - hunk.oldStart + 1
    hunk.newLines = newEnd - hunk.newStart + 1
  }
  return formatPatch({
    oldFileName: oldName,
    newFileName: newName,
    oldHeader: '',
    newHeader: '',
    hunks
  })
}

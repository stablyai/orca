import { formatPatch, type StructuredPatch } from 'diff'
import {
  computePierreLineChanges,
  splitPierreLines,
  type PierreLineChange
} from './pierre-diff-line-changes'

/** Unified patch with four context lines; changes within eight lines share a hunk. */
export function formatPierreLinePatch(
  oldName: string,
  newName: string,
  oldLines: readonly string[],
  newLines: readonly string[],
  changes: readonly PierreLineChange[]
): string {
  const hunks: StructuredPatch['hunks'] = []
  const append = (
    lines: readonly string[],
    from: number,
    to: number,
    prefix: string,
    output: string[]
  ) => {
    for (let i = from; i < to; i++) {
      const line = lines[i]
      output.push(prefix + (line.endsWith('\n') ? line.slice(0, -1) : line))
      if (!line.endsWith('\n')) {
        output.push('\\ No newline at end of file')
      }
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

export function buildPierreLinePatch(
  oldName: string,
  newName: string,
  original: string,
  modified: string,
  ignoreWhitespace: boolean
): { patch: string; timedOut: boolean } {
  const oldLines = splitPierreLines(original)
  const newLines = splitPierreLines(modified)
  const { changes, timedOut } = computePierreLineChanges(oldLines, newLines, ignoreWhitespace)
  return { patch: formatPierreLinePatch(oldName, newName, oldLines, newLines, changes), timedOut }
}

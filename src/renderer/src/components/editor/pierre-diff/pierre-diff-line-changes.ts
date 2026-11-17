import { DateTimeout } from 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm.js'
import { DynamicProgrammingDiffing } from 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/dynamicProgrammingDiffing.js'
import { MyersDiffAlgorithm } from 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm.js'
import {
  optimizeSequenceDiffs,
  removeVeryShortMatchingLinesBetweenDiffs
} from 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/heuristicSequenceOptimizations.js'
import { LineSequence } from 'monaco-editor/esm/vs/editor/common/diff/defaultLinesDiffComputer/lineSequence.js'

// Monaco's diff editor default `maxComputationTime`.
export const MONACO_DIFF_TIMEOUT_MS = 5_000

/** Zero-based line ranges with exclusive ends over lines that keep their `\n`. */
export type PierreLineChange = {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
}
export type PierreLineChanges = { changes: PierreLineChange[]; timedOut: boolean }

export function splitPierreLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

const withoutNewline = (line: string) => (line.endsWith('\n') ? line.slice(0, -1) : line)

/** Common prefix/suffix trimmed into one replacement: the result when Monaco times out. */
export function trimmedPierreReplacement(
  oldLines: readonly string[],
  newLines: readonly string[],
  ignoreWhitespace: boolean
): PierreLineChange[] {
  const equal = (a: string, b: string) => (ignoreWhitespace ? a.trim() === b.trim() : a === b)
  let start = 0
  while (
    start < oldLines.length &&
    start < newLines.length &&
    equal(oldLines[start], newLines[start])
  ) {
    start++
  }
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && equal(oldLines[oldEnd - 1], newLines[newEnd - 1])) {
    oldEnd--
    newEnd--
  }
  return oldEnd === start && newEnd === start
    ? []
    : [{ oldStart: start, oldEnd, newStart: start, newEnd }]
}

/**
 * Monaco's line alignment (DefaultLinesDiffComputer before character refinement): trimmed
 * perfect hashes, DP under 1,700 lines else Myers, its sequence heuristics, then exact-byte
 * scanning of hash-equal lines so whitespace and EOL changes still round-trip.
 */
export function computePierreLineChanges(
  oldLines: readonly string[],
  newLines: readonly string[],
  ignoreWhitespace: boolean,
  timeoutMs = MONACO_DIFF_TIMEOUT_MS
): PierreLineChanges {
  const hashes = new Map<string, number>()
  const hash = (line: string) => {
    const key = line.trim()
    let value = hashes.get(key)
    if (value === undefined) {
      value = hashes.size
      hashes.set(key, value)
    }
    return value
  }
  const oldText = oldLines.map(withoutNewline)
  const newText = newLines.map(withoutNewline)
  const left = new LineSequence(oldText.map(hash), oldText)
  const right = new LineSequence(newText.map(hash), newText)
  const timeout = new DateTimeout(timeoutMs)
  const result =
    left.length + right.length < 1700
      ? new DynamicProgrammingDiffing().compute(left, right, timeout, (offset1, offset2) =>
          oldText[offset1] === newText[offset2]
            ? newText[offset2].length === 0
              ? 0.1
              : 1 + Math.log(1 + newText[offset2].length)
            : 0.99
        )
      : new MyersDiffAlgorithm().compute(left, right, timeout)
  if (result.hitTimeout) {
    return {
      changes: trimmedPierreReplacement(oldLines, newLines, ignoreWhitespace),
      timedOut: true
    }
  }
  const diffs = removeVeryShortMatchingLinesBetweenDiffs(
    left,
    right,
    optimizeSequenceDiffs(left, right, result.diffs)
  )
  const changes: PierreLineChange[] = []
  const push = (change: PierreLineChange) => {
    if (change.oldStart === change.oldEnd && change.newStart === change.newEnd) {
      return
    }
    const last = changes.at(-1)
    if (last && last.oldEnd === change.oldStart && last.newEnd === change.newStart) {
      last.oldEnd = change.oldEnd
      last.newEnd = change.newEnd
    } else {
      changes.push(change)
    }
  }
  let oldCursor = 0
  let newCursor = 0
  const scanEqual = (oldEnd: number) => {
    for (; oldCursor < oldEnd; oldCursor++, newCursor++) {
      if (!ignoreWhitespace && oldLines[oldCursor] !== newLines[newCursor]) {
        push({
          oldStart: oldCursor,
          oldEnd: oldCursor + 1,
          newStart: newCursor,
          newEnd: newCursor + 1
        })
      }
    }
  }
  for (const { seq1Range, seq2Range } of diffs) {
    scanEqual(seq1Range.start)
    push({
      oldStart: seq1Range.start,
      oldEnd: seq1Range.endExclusive,
      newStart: seq2Range.start,
      newEnd: seq2Range.endExclusive
    })
    oldCursor = seq1Range.endExclusive
    newCursor = seq2Range.endExclusive
  }
  scanEqual(oldLines.length)
  return { changes, timedOut: false }
}

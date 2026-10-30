import type { Editor } from '@tiptap/react'
import type { RichMarkdownAnnotationHighlightRange } from './rich-markdown-annotation-highlight'
import { forEachRichMarkdownVisibleTextSegment } from './rich-markdown-visible-text-map'

type TextPosition = { from: number; to: number } | null

type NormalizedTextChar = {
  value: string
  pos: TextPosition
}

type MatchState = {
  readonly needle: string
  readonly prefixTable: number[]
  recentPositions: TextPosition[]
  recentPositionWriteIndex: number
  matchLength: number
  positions: TextPosition[] | null
}

type NormalizationState = {
  previousWasWhitespace: boolean
}

export function findRichMarkdownSelectedTextRanges({
  editor,
  selectedText,
  from,
  to
}: {
  editor: Editor
  selectedText: string
  from?: number
  to?: number
}): RichMarkdownAnnotationHighlightRange[] {
  const needle = normalizeSelectedText(selectedText)
  if (!needle) {
    return []
  }

  const matchState: MatchState = {
    needle,
    prefixTable: buildPrefixTable(needle),
    recentPositions: [],
    recentPositionWriteIndex: 0,
    matchLength: 0,
    positions: null
  }
  const normalizationState: NormalizationState = {
    previousWasWhitespace: false
  }

  forEachRichMarkdownVisibleTextSegment(
    editor.state.doc,
    from ?? 0,
    to ?? editor.state.doc.content.size,
    (segment) => {
      for (let index = 0; index < segment.text.length && !matchState.positions; index += 1) {
        processRawTextChar(
          {
            value: segment.text.charAt(index),
            pos:
              segment.kind === 'separator'
                ? null
                : segment.kind === 'read-only-atom'
                  ? { from: segment.from, to: segment.to }
                  : { from: segment.from + index, to: segment.from + index + 1 }
          },
          normalizationState,
          matchState
        )
      }
      return !matchState.positions
    }
  )

  return matchState.positions ? positionsToRanges(matchState.positions) : []
}

function normalizeSelectedText(value: string): string {
  let normalized = ''
  let previousWasWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isRichMarkdownWhitespace(code)) {
      if (normalized.length > 0 && !previousWasWhitespace) {
        normalized += ' '
      }
      previousWasWhitespace = true
      continue
    }
    normalized += value.charAt(index)
    previousWasWhitespace = false
  }
  return normalized
}

function processRawTextChar(
  char: NormalizedTextChar,
  normalizationState: NormalizationState,
  matchState: MatchState
): void {
  const code = char.value.charCodeAt(0)
  if (isRichMarkdownWhitespace(code)) {
    if (!normalizationState.previousWasWhitespace) {
      processNormalizedTextChar({ value: ' ', pos: char.pos }, matchState)
    }
    normalizationState.previousWasWhitespace = true
    return
  }

  processNormalizedTextChar(char, matchState)
  normalizationState.previousWasWhitespace = false
}

function processNormalizedTextChar(char: NormalizedTextChar, matchState: MatchState): void {
  recordRecentPosition(char.pos, matchState)
  while (matchState.matchLength > 0 && char.value !== matchState.needle[matchState.matchLength]) {
    matchState.matchLength = matchState.prefixTable[matchState.matchLength - 1] ?? 0
  }

  if (char.value !== matchState.needle[matchState.matchLength]) {
    return
  }

  matchState.matchLength += 1
  if (matchState.matchLength === matchState.needle.length) {
    matchState.positions = readRecentPositions(matchState)
  }
}

function recordRecentPosition(pos: TextPosition, matchState: MatchState): void {
  if (matchState.recentPositions.length < matchState.needle.length) {
    matchState.recentPositions.push(pos)
    matchState.recentPositionWriteIndex =
      matchState.recentPositions.length % matchState.needle.length
    return
  }

  matchState.recentPositions[matchState.recentPositionWriteIndex] = pos
  matchState.recentPositionWriteIndex =
    (matchState.recentPositionWriteIndex + 1) % matchState.needle.length
}

function readRecentPositions(matchState: MatchState): TextPosition[] {
  const positions: TextPosition[] = []
  for (let index = 0; index < matchState.needle.length; index += 1) {
    const bufferIndex = (matchState.recentPositionWriteIndex + index) % matchState.needle.length
    positions.push(matchState.recentPositions[bufferIndex] ?? null)
  }
  return positions
}

function buildPrefixTable(value: string): number[] {
  const table: number[] = []
  for (let index = 0; index < value.length; index += 1) {
    table.push(0)
  }
  let prefixLength = 0
  for (let index = 1; index < value.length; index += 1) {
    while (prefixLength > 0 && value[index] !== value[prefixLength]) {
      prefixLength = table[prefixLength - 1] ?? 0
    }
    if (value[index] === value[prefixLength]) {
      prefixLength += 1
      table[index] = prefixLength
    }
  }
  return table
}

function positionsToRanges(positions: TextPosition[]): RichMarkdownAnnotationHighlightRange[] {
  const ranges: RichMarkdownAnnotationHighlightRange[] = []
  let rangeFrom: number | null = null
  let rangeTo: number | null = null
  for (const position of positions) {
    if (position === null) {
      continue
    }
    if (rangeFrom === null || rangeTo === null) {
      rangeFrom = position.from
      rangeTo = position.to
      continue
    }
    if (position.from <= rangeTo) {
      rangeTo = Math.max(rangeTo, position.to)
      continue
    }
    ranges.push({ from: rangeFrom, to: rangeTo })
    rangeFrom = position.from
    rangeTo = position.to
  }
  if (rangeFrom !== null && rangeTo !== null) {
    ranges.push({ from: rangeFrom, to: rangeTo })
  }
  return ranges
}

function isRichMarkdownWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

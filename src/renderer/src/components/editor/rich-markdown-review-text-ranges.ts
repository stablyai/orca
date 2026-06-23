import type { Editor } from '@tiptap/react'
import type { RichMarkdownAnnotationHighlightRange } from './rich-markdown-annotation-highlight'

type NormalizedTextChar = {
  value: string
  pos: number | null
}

type MatchState = {
  readonly needle: string
  readonly prefixTable: number[]
  recentPositions: (number | null)[]
  recentPositionWriteIndex: number
  matchLength: number
  positions: (number | null)[] | null
}

type NormalizationState = {
  previousWasWhitespace: boolean
  emittedAnyText: boolean
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
    previousWasWhitespace: false,
    emittedAnyText: false
  }

  // Why: review text can come from large pasted selections; stream the editor
  // text instead of building per-character haystack/needle arrays.
  editor.state.doc.nodesBetween(from ?? 0, to ?? editor.state.doc.content.size, (node, pos) => {
    if (matchState.positions || !node.isText) {
      return
    }
    const nodeText = node.text
    if (!nodeText) {
      return
    }
    if (normalizationState.emittedAnyText) {
      processRawTextChar({ value: ' ', pos: null }, normalizationState, matchState)
    }
    for (let index = 0; index < nodeText.length && !matchState.positions; index += 1) {
      processRawTextChar(
        { value: nodeText.charAt(index), pos: pos + index },
        normalizationState,
        matchState
      )
    }
  })

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
      normalizationState.emittedAnyText = true
    }
    normalizationState.previousWasWhitespace = true
    return
  }

  processNormalizedTextChar(char, matchState)
  normalizationState.previousWasWhitespace = false
  normalizationState.emittedAnyText = true
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

function recordRecentPosition(pos: number | null, matchState: MatchState): void {
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

function readRecentPositions(matchState: MatchState): (number | null)[] {
  const positions: (number | null)[] = []
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

function positionsToRanges(positions: (number | null)[]): RichMarkdownAnnotationHighlightRange[] {
  const ranges: RichMarkdownAnnotationHighlightRange[] = []
  let rangeFrom: number | null = null
  let rangeTo: number | null = null
  for (const pos of positions) {
    if (pos === null) {
      continue
    }
    if (rangeFrom === null || rangeTo === null) {
      rangeFrom = pos
      rangeTo = pos + 1
      continue
    }
    if (pos === rangeTo) {
      rangeTo += 1
      continue
    }
    ranges.push({ from: rangeFrom, to: rangeTo })
    rangeFrom = pos
    rangeTo = pos + 1
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

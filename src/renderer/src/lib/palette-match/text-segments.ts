import type { NormalizedText } from './normalized-text'

/** A maximal alphanumeric run inside an atom, e.g. `08` in `2026-08-13`. */
export type PaletteComponent = { start: number; end: number; text: string }

/** A component further split at letter/digit and camelCase boundaries. */
export type PaletteWord = { start: number; end: number; text: string }

/**
 * A whitespace-delimited chunk. Separator normalization is scoped to one atom so
 * a compact query can never join characters from two of them.
 */
export type PaletteAtom = {
  start: number
  end: number
  components: PaletteComponent[]
  compact: string
  /** compact index -> normalized index of the source character */
  compactOffsets: Int32Array
}

const ALPHANUMERIC = /[\p{L}\p{N}]/u
const LETTER = /\p{L}/u
const DIGIT = /\p{N}/u
const UPPERCASE = /\p{Lu}/u

function isAlphanumeric(char: string): boolean {
  return ALPHANUMERIC.test(char)
}

function originalIndexAt(text: NormalizedText, index: number): number {
  return text.starts ? text.starts[index] : index
}

function isCamelBoundary(text: NormalizedText, index: number): boolean {
  if (index <= 0) {
    return false
  }
  const original = text.original
  const here = originalIndexAt(text, index)
  const before = originalIndexAt(text, index - 1)
  if (here === before) {
    return false
  }
  return UPPERCASE.test(original[here] ?? '') && !UPPERCASE.test(original[before] ?? '')
}

function splitComponentIntoWords(text: NormalizedText, component: PaletteComponent): PaletteWord[] {
  const words: PaletteWord[] = []
  const normalized = text.normalized
  let start = component.start
  for (let index = component.start + 1; index < component.end; index += 1) {
    const previous = normalized[index - 1]
    const current = normalized[index]
    const classChanged =
      (LETTER.test(previous) && DIGIT.test(current)) ||
      (DIGIT.test(previous) && LETTER.test(current))
    if (classChanged || isCamelBoundary(text, index)) {
      words.push({ start, end: index, text: normalized.slice(start, index) })
      start = index
    }
  }
  words.push({ start, end: component.end, text: normalized.slice(start, component.end) })
  return words
}

function buildAtom(text: NormalizedText, start: number, end: number): PaletteAtom {
  const normalized = text.normalized
  const components: PaletteComponent[] = []
  let compact = ''
  const compactOffsets: number[] = []
  let runStart = -1

  for (let index = start; index <= end; index += 1) {
    const inRun = index < end && isAlphanumeric(normalized[index])
    if (inRun) {
      if (runStart === -1) {
        runStart = index
      }
      compact += normalized[index]
      compactOffsets.push(index)
    } else if (runStart !== -1) {
      components.push({ start: runStart, end: index, text: normalized.slice(runStart, index) })
      runStart = -1
    }
  }

  return { start, end, components, compact, compactOffsets: Int32Array.from(compactOffsets) }
}

export type PaletteTextSegments = {
  atoms: PaletteAtom[]
  words: PaletteWord[]
}

/** Splits folded text into atoms, components, and words once per document build. */
export function segmentPaletteText(text: NormalizedText): PaletteTextSegments {
  const normalized = text.normalized
  const atoms: PaletteAtom[] = []
  const words: PaletteWord[] = []
  let start = -1

  for (let index = 0; index <= normalized.length; index += 1) {
    const isSpace = index === normalized.length || normalized[index] === ' '
    if (!isSpace) {
      if (start === -1) {
        start = index
      }
      continue
    }
    if (start !== -1) {
      const atom = buildAtom(text, start, index)
      atoms.push(atom)
      for (const component of atom.components) {
        words.push(...splitComponentIntoWords(text, component))
      }
      start = -1
    }
  }

  return { atoms, words }
}

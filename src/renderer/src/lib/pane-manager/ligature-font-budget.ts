// @xterm/addon-ligatures expands every calt chained-context rule into explicit glyph trees and
// merges them across subtables. Commit Mono's 24M contexts cost ~200MB of heap and seconds of
// main-thread parse per load, so estimate that expansion from raw GSUB bytes before parsing.

/** Fira Code, JetBrains Mono, Cascadia, Iosevka, Monaspace, Maple Mono and Nerd Font builds stay under 0.2M. */
export const MAX_LIGATURE_FONT_CONTEXTS = 2_000_000
/** opentype.js keeps whole-font tables alive (~5-13x file size), so skip very large files. */
export const MAX_LIGATURE_FONT_BYTES = 32 * 1024 * 1024

const TAG_GSUB = 0x47535542
const TAG_CALT = 0x63616c74
const TAG_TTCF = 0x74746366

type Reader = {
  u16(offset: number): number
  u32(offset: number): number
}

function createReader(buffer: ArrayBuffer): Reader {
  const view = new DataView(buffer)
  // DataView throws RangeError past the end, which callers treat as an over-budget font.
  return {
    u16: (offset) => view.getUint16(offset),
    u32: (offset) => view.getUint32(offset)
  }
}

function findTable(reader: Reader, tag: number): number | null {
  const numTables = reader.u16(4)
  for (let index = 0; index < numTables; index++) {
    const record = 12 + index * 16
    if (reader.u32(record) === tag) {
      return reader.u32(record + 8)
    }
  }
  return null
}

/** Entries the addon iterates: one per glyph (format 1) or per range (format 2). */
function coverageEntryCount(reader: Reader, offset: number): number {
  const format = reader.u16(offset)
  if (format === 1 || format === 2) {
    return reader.u16(offset + 2)
  }
  throw new RangeError(`Unknown coverage format ${format}`)
}

function coverageProduct(
  reader: Reader,
  base: number,
  countOffset: number
): {
  product: number
  next: number
} {
  const count = reader.u16(countOffset)
  let product = 1
  for (let index = 0; index < count; index++) {
    product *= coverageEntryCount(reader, base + reader.u16(countOffset + 2 + index * 2))
  }
  return { product, next: countOffset + 2 + count * 2 }
}

/** Range count per class; format 1 class defs yield no glyphs in the addon's tree builder. */
function classRangeCounts(reader: Reader, offset: number): Map<number, number> {
  const counts = new Map<number, number>()
  if (reader.u16(offset) !== 2) {
    return counts
  }
  const rangeCount = reader.u16(offset + 2)
  for (let index = 0; index < rangeCount; index++) {
    const classId = reader.u16(offset + 4 + index * 6 + 4)
    counts.set(classId, (counts.get(classId) ?? 0) + 1)
  }
  return counts
}

function classSequenceProduct(
  reader: Reader,
  countOffset: number,
  counts: Map<number, number>,
  firstIndex: number
): { product: number; next: number } {
  const count = reader.u16(countOffset)
  let product = 1
  for (let index = firstIndex; index < count; index++) {
    product *= counts.get(reader.u16(countOffset + 2 + (index - firstIndex) * 2)) ?? 0
  }
  return { product, next: countOffset + 2 + (count - firstIndex) * 2 }
}

function chainedClassContexts(reader: Reader, subtable: number): number {
  const firstGlyphs = coverageEntryCount(reader, subtable + reader.u16(subtable + 2))
  const backtrack = classRangeCounts(reader, subtable + reader.u16(subtable + 4))
  const input = classRangeCounts(reader, subtable + reader.u16(subtable + 6))
  const lookahead = classRangeCounts(reader, subtable + reader.u16(subtable + 8))
  const classSetCount = reader.u16(subtable + 10)
  let total = 0
  for (let classId = 0; classId < classSetCount; classId++) {
    const setOffset = reader.u16(subtable + 12 + classId * 2)
    if (setOffset === 0 || !input.has(classId)) {
      continue
    }
    const set = subtable + setOffset
    const ruleCount = reader.u16(set)
    for (let ruleIndex = 0; ruleIndex < ruleCount; ruleIndex++) {
      const rule = set + reader.u16(set + 2 + ruleIndex * 2)
      const back = classSequenceProduct(reader, rule, backtrack, 0)
      // Input sequence counts include the already-matched first glyph.
      const inputSeq = classSequenceProduct(reader, back.next, input, 1)
      const ahead = classSequenceProduct(reader, inputSeq.next, lookahead, 0)
      total +=
        Math.min(firstGlyphs, input.get(classId) ?? 0) *
        back.product *
        inputSeq.product *
        ahead.product
    }
  }
  return total
}

function subtableContexts(reader: Reader, lookupType: number, subtable: number): number {
  const format = reader.u16(subtable)
  if (lookupType === 6 && format === 1) {
    // Glyph-based rules enumerate explicit sequences: one context per rule.
    const ruleSetCount = reader.u16(subtable + 4)
    let rules = 0
    for (let index = 0; index < ruleSetCount; index++) {
      const setOffset = reader.u16(subtable + 6 + index * 2)
      if (setOffset !== 0) {
        rules += reader.u16(subtable + setOffset)
      }
    }
    return rules
  }
  if (lookupType === 6 && format === 2) {
    return chainedClassContexts(reader, subtable)
  }
  if (lookupType === 6 && format === 3) {
    const back = coverageProduct(reader, subtable, subtable + 2)
    const input = coverageProduct(reader, subtable, back.next)
    const ahead = coverageProduct(reader, subtable, input.next)
    return back.product * input.product * ahead.product
  }
  if (lookupType === 8 && format === 1) {
    const first = coverageEntryCount(reader, subtable + reader.u16(subtable + 2))
    const back = coverageProduct(reader, subtable, subtable + 4)
    const ahead = coverageProduct(reader, subtable, back.next)
    return first * back.product * ahead.product
  }
  return 0
}

function caltLookupIndexes(reader: Reader, gsub: number): Set<number> {
  const featureList = gsub + reader.u16(gsub + 6)
  const featureCount = reader.u16(featureList)
  const indexes = new Set<number>()
  for (let index = 0; index < featureCount; index++) {
    const record = featureList + 2 + index * 6
    if (reader.u32(record) !== TAG_CALT) {
      continue
    }
    const feature = featureList + reader.u16(record + 4)
    const lookupCount = reader.u16(feature + 2)
    for (let lookup = 0; lookup < lookupCount; lookup++) {
      indexes.add(reader.u16(feature + 4 + lookup * 2))
    }
  }
  return indexes
}

/** Upper bound on the glyph contexts the addon builds for this font's calt feature. */
export function estimateLigatureFontContexts(buffer: ArrayBuffer): number {
  const reader = createReader(buffer)
  // The addon's parser rejects collections; never hand them over.
  if (reader.u32(0) === TAG_TTCF) {
    return Number.POSITIVE_INFINITY
  }
  const gsub = findTable(reader, TAG_GSUB)
  if (gsub === null) {
    return 0
  }
  const lookupList = gsub + reader.u16(gsub + 8)
  const lookupCount = reader.u16(lookupList)
  let total = 0
  for (const lookupIndex of caltLookupIndexes(reader, gsub)) {
    if (lookupIndex >= lookupCount) {
      continue
    }
    const lookup = lookupList + reader.u16(lookupList + 2 + lookupIndex * 2)
    // The addon builds trees only for lookup types 6 and 8; opentype.js leaves type 7 extensions wrapped.
    const lookupType = reader.u16(lookup)
    if (lookupType !== 6 && lookupType !== 8) {
      continue
    }
    const subtableCount = reader.u16(lookup + 4)
    for (let index = 0; index < subtableCount; index++) {
      total += subtableContexts(reader, lookupType, lookup + reader.u16(lookup + 6 + index * 2))
    }
  }
  return total
}

export function isLigatureFontWithinBudget(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength > MAX_LIGATURE_FONT_BYTES) {
    return false
  }
  try {
    return estimateLigatureFontContexts(buffer) <= MAX_LIGATURE_FONT_CONTEXTS
  } catch {
    // Truncated or malformed tables would fail the addon's parse too; fall back without parsing.
    return false
  }
}

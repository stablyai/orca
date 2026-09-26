import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from '@sanity/diff-match-patch'

// Three-way line merge used as the lossless fallback for markdown save reconciliation.
// base = canonical serialization of the on-disk bytes; ours = the on-disk bytes;
// theirs = canonical serialization after the user's edit. Regions the user did NOT
// touch (base == theirs) emit `ours` verbatim, so untouched content keeps its exact
// original bytes; regions the user DID touch emit `theirs` (canonical). No TipTap
// re-parse, so cost scales with the line diff rather than O(n^2) document size.

// Why: line diffs run only on the save/debounce fallback path, never per keystroke;
// a 1s ceiling keeps a pathological input from stalling without truncating normal edits.
const LINE_DIFF_TIMEOUT_SECONDS = 1

type LineRegion = { baseLo: number; baseHi: number; sideLo: number; sideHi: number }

/** Splits into lines that each retain their trailing "\n", so a plain join is lossless. */
function splitLinesKeepingEol(text: string): string[] {
  if (text === '') {
    return []
  }
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

/** Encodes each distinct line as one code point so a char diff behaves as a line diff. */
function encodeLines(base: string[], side: string[]): { encodedBase: string; encodedSide: string } {
  const lineToChar = new Map<string, string>()
  const encode = (lines: string[]): string =>
    lines
      .map((line) => {
        let char = lineToChar.get(line)
        if (char === undefined) {
          char = String.fromCodePoint(lineToChar.size)
          lineToChar.set(line, char)
        }
        return char
      })
      .join('')
  return { encodedBase: encode(base), encodedSide: encode(side) }
}

/**
 * Regions where `base` and `side` differ, in base coordinates plus the aligned side
 * range, and `baseToSide[i]` mapping every base index to its aligned side index (exact
 * at equal boundaries — which is where merge regions begin and end).
 */
function diffLineRegions(
  base: string[],
  side: string[]
): { regions: LineRegion[]; baseToSide: number[] } {
  const { encodedBase, encodedSide } = encodeLines(base, side)
  const diffs = makeDiff(encodedBase, encodedSide, { timeout: LINE_DIFF_TIMEOUT_SECONDS })

  const regions: LineRegion[] = []
  const baseToSide: number[] = Array.from({ length: base.length + 1 }, () => 0)
  let baseIdx = 0
  let sideIdx = 0
  let pending: LineRegion | null = null
  const flush = (): void => {
    if (pending) {
      regions.push(pending)
      pending = null
    }
  }
  for (const [op, chunk] of diffs) {
    const count = chunk.length
    if (op === DIFF_EQUAL) {
      flush()
      for (let i = 0; i < count; i += 1) {
        baseToSide[baseIdx] = sideIdx
        baseIdx += 1
        sideIdx += 1
      }
    } else if (op === DIFF_DELETE) {
      pending ??= { baseLo: baseIdx, baseHi: baseIdx, sideLo: sideIdx, sideHi: sideIdx }
      for (let i = 0; i < count; i += 1) {
        baseToSide[baseIdx] = sideIdx
        baseIdx += 1
      }
      pending.baseHi = baseIdx
      pending.sideHi = sideIdx
    } else if (op === DIFF_INSERT) {
      pending ??= { baseLo: baseIdx, baseHi: baseIdx, sideLo: sideIdx, sideHi: sideIdx }
      sideIdx += count
      pending.sideHi = sideIdx
    }
  }
  flush()
  baseToSide[baseIdx] = sideIdx
  return { regions, baseToSide }
}

type Hunk = LineRegion & { side: 'ours' | 'theirs' }

/**
 * diff3 line merge. Returns null when a line diff timed out into a degenerate
 * whole-document rewrite (protecting against silently dropping untouched content),
 * so the caller can keep its existing canonical fallback.
 */
export function mergeMarkdownSourceByLines(
  originalSource: string,
  baseCanonical: string,
  edited: string
): string | null {
  const baseLines = splitLinesKeepingEol(baseCanonical)
  const oursLines = splitLinesKeepingEol(originalSource)
  const theirsLines = splitLinesKeepingEol(edited)

  const ours = diffLineRegions(baseLines, oursLines)
  const theirs = diffLineRegions(baseLines, theirsLines)

  // A single region spanning the whole base means the diff collapsed (e.g. timeout);
  // merging would relocate untouched content, so bail to the caller's fallback.
  const collapsed = (regions: LineRegion[]): boolean =>
    baseLines.length > 0 &&
    regions.length === 1 &&
    regions[0].baseLo === 0 &&
    regions[0].baseHi === baseLines.length
  if (collapsed(ours.regions) && collapsed(theirs.regions)) {
    return null
  }

  const hunks: Hunk[] = [
    ...ours.regions.map((r) => ({ ...r, side: 'ours' as const })),
    ...theirs.regions.map((r) => ({ ...r, side: 'theirs' as const }))
  ].sort((a, b) => a.baseLo - b.baseLo || a.baseHi - b.baseHi)

  // A region's aligned side range unions the stable-boundary mapping with any absorbed
  // hunk ranges, so inserted lines sitting exactly at a boundary are not skipped.
  const sideRange = (
    lines: number[],
    absorbed: Hunk[],
    which: 'ours' | 'theirs',
    regionLo: number,
    regionHi: number
  ): [number, number] => {
    let lo = lines[regionLo]
    let hi = lines[regionHi]
    for (const hunk of absorbed) {
      if (hunk.side === which) {
        lo = Math.min(lo, hunk.sideLo)
        hi = Math.max(hi, hunk.sideHi)
      }
    }
    return [lo, hi]
  }

  const out: string[] = []
  let baseCursor = 0
  let hunkIdx = 0
  while (hunkIdx < hunks.length) {
    let regionLo = hunks[hunkIdx].baseLo
    let regionHi = hunks[hunkIdx].baseHi
    const absorbed: Hunk[] = [hunks[hunkIdx]]
    hunkIdx += 1
    // Absorb only hunks that truly overlap (share a base line) the growing region;
    // hunks that merely abut a boundary stay independent so an ours style change and
    // an adjacent theirs edit don't collapse into one theirs-wins conflict.
    while (hunkIdx < hunks.length && hunks[hunkIdx].baseLo < regionHi) {
      const hunk = hunks[hunkIdx]
      regionLo = Math.min(regionLo, hunk.baseLo)
      regionHi = Math.max(regionHi, hunk.baseHi)
      absorbed.push(hunk)
      hunkIdx += 1
    }

    // Stable gap before the region: base == ours == theirs, emit ours (original bytes).
    for (let i = baseCursor; i < regionLo; i += 1) {
      out.push(oursLines[ours.baseToSide[i]])
    }

    // Take theirs where the user edited (even overlapping a style-only change); take
    // ours where only style differs, preserving the original bytes.
    const sawTheirs = absorbed.some((hunk) => hunk.side === 'theirs')
    const [lo, hi] = sawTheirs
      ? sideRange(theirs.baseToSide, absorbed, 'theirs', regionLo, regionHi)
      : sideRange(ours.baseToSide, absorbed, 'ours', regionLo, regionHi)
    const source = sawTheirs ? theirsLines : oursLines
    for (let i = lo; i < hi; i += 1) {
      out.push(source[i])
    }
    baseCursor = regionHi
  }

  // Trailing stable region.
  for (let i = baseCursor; i < baseLines.length; i += 1) {
    out.push(oursLines[ours.baseToSide[i]])
  }

  return out.join('')
}

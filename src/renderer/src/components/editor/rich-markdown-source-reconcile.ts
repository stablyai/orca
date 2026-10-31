import {
  applyPatches,
  cleanupEfficiency,
  cleanupSemantic,
  makeDiff,
  makePatches
} from '@sanity/diff-match-patch'
import {
  getUtf8ByteLengthForCodePoint,
  readUtf8CodePointAt
} from '../../../../shared/utf8-byte-limits'

// Bound UTF-16 length so the throwaway safety parse stays within the serialization debounce budget.
const RECONCILE_SIZE_CAP_CODE_UNITS = 50_000

// Bound replacement-heavy searches; the round-trip proof rejects coarse timeout results that misplaced content.
const RECONCILE_DIFF_TIMEOUT_SECONDS = 0.01

export type ReconcileSerializedMarkdownParams = {
  /** Source-style baseline, possibly noncanonical or CRLF. */
  originalSource: string
  /** Canonical serialization of `originalSource` (what getMarkdown returns unedited). */
  baseCanonical: string
  /** Canonical serialization after the user's edit (getMarkdown, always LF). */
  edited: string
  /** Reparse through the live pipeline; null is a failed proof requiring canonical fallback. */
  roundTrip: (markdown: string) => string | null
}

export function restoreMarkdownSourceEol(markdown: string, source: string): string {
  return restoreEol(toLf(markdown), detectDominantEol(source))
}

/** Preserve untouched source style only when the edited document survives the render-equivalence proof; otherwise use canonical output. */
export function reconcileSerializedMarkdown({
  originalSource,
  baseCanonical,
  edited,
  roundTrip
}: ReconcileSerializedMarkdownParams): string {
  if (edited === baseCanonical) {
    return originalSource
  }

  // Patch in LF space for reliable fuzzy matching, then restore source EOL on every non-verbatim return.
  const eol = detectDominantEol(originalSource)
  const originalSourceLf = toLf(originalSource)
  const baseLf = toLf(baseCanonical)
  const editedLf = toLf(edited)

  // Canonical source needs no reparse; restrict trailing newlines to avoid adding &nbsp; paragraphs or dropping real empty blocks.
  const originalTrailingNewlines = originalSourceLf.match(/\n+$/)?.[0] ?? ''
  if (
    originalTrailingNewlines.length <= 1 &&
    !editedLf.endsWith('\n') &&
    stripTrailingNewlines(originalSourceLf) === stripTrailingNewlines(baseLf)
  ) {
    return restoreEol(editedLf + originalTrailingNewlines, eol)
  }

  if (
    Math.max(originalSource.length, baseCanonical.length, edited.length) >
    RECONCILE_SIZE_CAP_CODE_UNITS
  ) {
    return restoreEol(editedLf, eol)
  }

  // Repeated-seed half-match scans ignore the diff deadline; use canonical fallback for highly repetitive replacements.
  if (hasRepeatedHalfMatchSeed(baseLf, editedLf)) {
    return restoreEol(editedLf, eol)
  }
  let diffs = makeDiff(baseLf, editedLf, {
    checkLines: true,
    timeout: RECONCILE_DIFF_TIMEOUT_SECONDS
  })
  // Match makePatches's cleanup while supplying our own bounded diff, avoiding the library's 1s timeout.
  if (diffs.length > 2) {
    diffs = cleanupSemantic(diffs)
    diffs = cleanupEfficiency(diffs)
  }
  const patches = makePatches(baseLf, diffs)
  // applyPatches reads UTF-8 offsets but makePatches emits UTF-16 indices; encode against the divergent source to retain fuzzy seeds.
  const utf8Offsets = getUtf8OffsetsAtCodeUnitIndices(
    originalSourceLf,
    patches.flatMap((patch) => [patch.start1, patch.start2])
  )
  for (const patch of patches) {
    patch.start1 = utf8Offsets.get(patch.start1) ?? 0
    patch.start2 = utf8Offsets.get(patch.start2) ?? 0
  }
  const [reconciledLf, results] = applyPatches(patches, originalSourceLf)

  if (results.some((applied) => !applied)) {
    return restoreEol(editedLf, eol)
  }

  // Reject fuzzy placements whose reparsed document differs from the canonical edit.
  const reparsed = roundTrip(reconciledLf)
  if (reparsed === null || normalizeForSafety(reparsed) !== normalizeForSafety(editedLf)) {
    return restoreEol(editedLf, eol)
  }

  return restoreEol(reconciledLf, eol)
}

function stripTrailingNewlines(lfText: string): string {
  return lfText.replace(/\n+$/, '')
}

function detectDominantEol(text: string): '\n' | '\r\n' {
  if (!text.includes('\r')) {
    return '\n'
  }
  const totalLf = (text.match(/\n/g) ?? []).length
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lfOnly = totalLf - crlf
  return crlf > 0 && crlf >= lfOnly ? '\r\n' : '\n'
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreEol(lfText: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText
}

function normalizeForSafety(text: string): string {
  // Normalize CRLF only; trimEnd would hide semantic trailing empty paragraphs.
  return text.replace(/\r\n/g, '\n')
}

function getUtf8OffsetsAtCodeUnitIndices(
  text: string,
  codeUnitIndices: number[]
): Map<number, number> {
  const targets = [...new Set(codeUnitIndices)].sort((a, b) => a - b)
  const offsets = new Map<number, number>()
  let codeUnitIndex = 0
  let byteOffset = 0
  for (const target of targets) {
    const boundedTarget = Math.max(0, Math.min(target, text.length))
    while (codeUnitIndex < boundedTarget) {
      const codePoint = readUtf8CodePointAt(text, codeUnitIndex)
      byteOffset += getUtf8ByteLengthForCodePoint(codePoint)
      codeUnitIndex += codePoint > 0xffff ? 2 : 1
    }
    offsets.set(target, byteOffset)
  }
  return offsets
}

function hasRepeatedHalfMatchSeed(textA: string, textB: string): boolean {
  // Match diff-match-patch's prefix/suffix trimming so a small edit isn't mistaken for a repetitive replacement.
  const minimumLength = Math.min(textA.length, textB.length)
  let prefixLength = 0
  while (
    prefixLength < minimumLength &&
    textA.charCodeAt(prefixLength) === textB.charCodeAt(prefixLength)
  ) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < minimumLength - prefixLength &&
    textA.charCodeAt(textA.length - suffixLength - 1) ===
      textB.charCodeAt(textB.length - suffixLength - 1)
  ) {
    suffixLength += 1
  }
  const middleA = textA.slice(prefixLength, textA.length - suffixLength)
  const middleB = textB.slice(prefixLength, textB.length - suffixLength)
  const longText = middleA.length > middleB.length ? middleA : middleB
  const shortText = middleA.length > middleB.length ? middleB : middleA
  if (longText.length < 4 || shortText.length * 2 < longText.length) {
    return false
  }

  const seedLength = Math.floor(longText.length / 4)
  for (const start of [Math.ceil(longText.length / 4), Math.ceil(longText.length / 2)]) {
    const seed = longText.slice(start, start + seedLength)
    const firstMatch = shortText.indexOf(seed)
    if (firstMatch !== -1 && shortText.includes(seed, firstMatch + 1)) {
      return true
    }
  }
  return false
}

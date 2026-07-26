import {
  applyPatches,
  cleanupEfficiency,
  cleanupSemantic,
  makeDiff,
  makePatches
} from '@sanity/diff-match-patch'

// Why: cap document size in UTF-16 code units (`.length`) since re-parse cost scales with length — the per-commit throwaway TipTap safety re-parse (~50-67ms here) must stay under the 300ms serialize debounce so it can't stall the main thread on slow/SSH hosts.
const RECONCILE_SIZE_CAP_CODE_UNITS = 50_000

// Why: dmp's default 1s search freezes the renderer on replacement-heavy paths; a coarse timed-out diff is safe since the round-trip proof below rejects bad placements.
const RECONCILE_DIFF_TIMEOUT_SECONDS = 0.01

export type ReconcileSerializedMarkdownParams = {
  /** Current on-disk source bytes (possibly non-canonical, possibly CRLF). */
  originalSource: string
  /** Canonical serialization of `originalSource` (what getMarkdown returns unedited). */
  baseCanonical: string
  /** Canonical serialization after the user's edit (getMarkdown, always LF). */
  edited: string
  /**
   * Re-serializes reconciled bytes through the live editor's pipeline; injected so the reconcile logic is unit-testable without a DOM.
   * Returns null when the throwaway serializer fails (treated as a safety mismatch → canonical fallback).
   */
  roundTrip: (markdown: string) => string | null
}

export function restoreMarkdownSourceEol(markdown: string, source: string): string {
  return restoreEol(toLf(markdown), detectDominantEol(source))
}

/**
 * Carries the user's edit into the original source style so untouched regions keep their non-canonical bytes.
 * Falls back to canonical `edited` when the transform can't be proven render-equivalent, so it never corrupts or relocates content.
 */
export function reconcileSerializedMarkdown({
  originalSource,
  baseCanonical,
  edited,
  roundTrip
}: ReconcileSerializedMarkdownParams): string {
  // Branch 1: no semantic change vs the unedited doc → return the original bytes verbatim, zero disk churn.
  if (edited === baseCanonical) {
    return originalSource
  }

  // Work in LF space (getMarkdown emits LF, `originalSource` may be CRLF → CRLF fuzzy-matches poorly); restoreEol on every non-verbatim return keeps a uniform-CRLF file from silently flipping to LF.
  const eol = detectDominantEol(originalSource)
  const originalSourceLf = toLf(originalSource)
  const baseLf = toLf(baseCanonical)
  const editedLf = toLf(edited)

  // Branch 2: source == edited except for EOL/trailing newlines → carry the source's EOL onto the edit and skip the re-parse; guards avoid a spurious `&nbsp;` paragraph and dropping a real trailing block.
  const originalTrailingNewlines = originalSourceLf.match(/\n+$/)?.[0] ?? ''
  if (
    originalTrailingNewlines.length <= 1 &&
    !editedLf.endsWith('\n') &&
    stripTrailingNewlines(originalSourceLf) === stripTrailingNewlines(baseLf)
  ) {
    return restoreEol(editedLf + originalTrailingNewlines, eol)
  }

  // Branch 3: oversize → bounded-cost canonical fallback (today's behavior).
  if (
    Math.max(originalSource.length, baseCanonical.length, edited.length) >
    RECONCILE_SIZE_CAP_CODE_UNITS
  ) {
    return restoreEol(editedLf, eol)
  }

  // Branch 4: run the divergent-base patch entirely in LF space.
  // Why: dmp's half-match accelerator ignores the diff deadline (100ms+ on repeated seeds), so bail to canonical for highly repetitive replacements.
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
  // Why: applyPatches decodes starts as UTF-8 offsets even though makePatches returns UTF-16 indices; encode against the divergent text being patched so decoding preserves the fuzzy-match seed.
  const utf8Offsets = getUtf8OffsetsAtCodeUnitIndices(
    originalSourceLf,
    patches.flatMap((patch) => [patch.start1, patch.start2])
  )
  for (const patch of patches) {
    patch.start1 = utf8Offsets.get(patch.start1) ?? 0
    patch.start2 = utf8Offsets.get(patch.start2) ?? 0
  }
  const [reconciledLf, results] = applyPatches(patches, originalSourceLf)

  // Branch 5: a hunk failed to locate in the non-canonical source → unreliable fuzzy match, fall back to canonical.
  if (results.some((applied) => !applied)) {
    return restoreEol(editedLf, eol)
  }

  // Branch 6: prove reconciled bytes render-equal the editor's document — any fuzzy misplacement changes canonical output and is caught here → canonical fallback.
  const reparsed = roundTrip(reconciledLf)
  if (reparsed === null || normalizeForSafety(reparsed) !== normalizeForSafety(editedLf)) {
    return restoreEol(editedLf, eol)
  }

  // Restore the detected EOL as the final step so reconciled CRLF stays CRLF.
  return restoreEol(reconciledLf, eol)
}

function stripTrailingNewlines(lfText: string): string {
  return lfText.replace(/\n+$/, '')
}

function detectDominantEol(text: string): '\n' | '\r\n' {
  const totalLf = (text.match(/\n/g) ?? []).length
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lfOnly = totalLf - crlf
  return crlf > 0 && crlf >= lfOnly ? '\r\n' : '\n'
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreEol(lfText: string, eol: '\n' | '\r\n'): string {
  // lfText is pure LF, so a blind LF→CRLF replace produces no mixed endings.
  return eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText
}

function normalizeForSafety(text: string): string {
  // Why: compare exactly (only CRLF-normalized) — a trailing `\n\n` empty paragraph is semantic, so a lenient trimEnd would mask the trailing-block drift branch 6 must catch.
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
      const codePoint = text.codePointAt(codeUnitIndex)
      if (codePoint === undefined) {
        break
      }
      byteOffset += utf8CodePointLength(codePoint)
      codeUnitIndex += codePoint > 0xffff ? 2 : 1
    }
    offsets.set(target, byteOffset)
  }
  return offsets
}

function utf8CodePointLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
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

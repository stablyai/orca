import { mergeMatchRanges, type MatchRange } from '@/lib/palette-match/normalized-text'
import {
  paletteTranscriptLiteralOccurrences,
  preparePaletteTranscriptProofQuery,
  type PaletteTranscriptSourceBoundaries,
  type PaletteTranscriptOccurrence
} from '../../../../shared/palette-transcript-literal'
import type { PaletteTranscriptSnippet } from '../worktree-jump-palette-model'

export { preparePaletteTranscriptProofQuery } from '../../../../shared/palette-transcript-literal'
export const TRANSCRIPT_PROOF_WINDOW_LIMIT = 8
export type PaletteTranscriptWindow = PaletteTranscriptSnippet & {
  sourceStart: number
  sourceRanges: readonly MatchRange[]
}

function windowFor(
  text: string,
  span: MatchRange,
  occurrences: readonly PaletteTranscriptOccurrence[],
  context: number
): PaletteTranscriptWindow {
  let start = Math.max(0, span.start - context)
  let end = Math.min(text.length, span.end + context)
  // Context must also stop at a code-point boundary.
  if (start > 0 && /[\uDC00-\uDFFF]/u.test(text[start])) {
    start--
  }
  if (end < text.length && /[\uDC00-\uDFFF]/u.test(text[end])) {
    end++
  }
  const sourceRanges = mergeMatchRanges(
    occurrences
      .filter((range) => range.start >= span.start && range.end <= span.end)
      .map(({ start, end }) => ({ start, end }))
  )
  return {
    text: text.slice(start, end),
    ranges: sourceRanges.map((range) => ({ start: range.start - start, end: range.end - start })),
    leadingEllipsis: start > 0,
    trailingEllipsis: end < text.length,
    sourceStart: start,
    sourceRanges
  }
}

/** Bounded original-text windows; callers must verify highlighted DOM fit before promotion. */
export function classifyPaletteTranscriptProof(
  text: unknown,
  query: string | readonly string[],
  boundaries: PaletteTranscriptSourceBoundaries = {}
): readonly PaletteTranscriptWindow[] {
  if (
    typeof text !== 'string' ||
    !text ||
    text.length > 1024 ||
    Array.from(text).length > 512 ||
    Array.from(text).some((point) => point.length === 1 && /[\uD800-\uDFFF]/u.test(point))
  ) {
    return []
  }
  const requirements = typeof query === 'string' ? preparePaletteTranscriptProofQuery(query) : query
  if (!requirements.length) {
    return []
  }
  const occurrences = paletteTranscriptLiteralOccurrences(text, requirements, boundaries)
  if (new Set(occurrences.map((occurrence) => occurrence.group)).size !== requirements.length) {
    return []
  }
  // Sweep ends, retaining the latest start per requirement; repeated anchors stay useful.
  occurrences.sort((a, b) => a.end - b.end || a.start - b.start || a.group - b.group)
  const latest = new Map<number, PaletteTranscriptOccurrence>()
  const spans = new Map<string, MatchRange>()
  for (const occurrence of occurrences) {
    if ((latest.get(occurrence.group)?.start ?? -1) < occurrence.start) {
      latest.set(occurrence.group, occurrence)
    }
    if (latest.size !== requirements.length) {
      continue
    }
    const start = Math.min(...Array.from(latest.values(), (range) => range.start))
    spans.set(`${start}:${occurrence.end}`, { start, end: occurrence.end })
  }
  const best = [...spans.values()]
    .sort((a, b) => a.end - a.start - (b.end - b.start) || a.start - b.start)
    .slice(0, TRANSCRIPT_PROOF_WINDOW_LIMIT / 2)
  return best.flatMap((span) => [
    windowFor(text, span, occurrences, 16),
    windowFor(text, span, occurrences, 0)
  ])
}

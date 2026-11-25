import { mergeMatchRanges, type MatchRange } from './normalized-text'
import type {
  PaletteDocument,
  PaletteSupportingEvidence,
  PaletteTokenAssignment
} from './palette-document'

export function buildSupportingEvidence(
  document: PaletteDocument,
  assignments: readonly PaletteTokenAssignment[],
  evidenceId: string | null
): PaletteSupportingEvidence[] {
  const unit = evidenceId ? document.evidenceUnits.get(evidenceId) : undefined
  if (!unit) {
    return []
  }
  const ranges: MatchRange[] = []
  for (const assignment of assignments) {
    const offset = document.renderOffsetByFieldId.get(assignment.fieldId)
    if (offset === undefined) {
      continue
    }
    for (const range of assignment.ranges) {
      const start = Math.min(range.start + offset, unit.text.length)
      const end = Math.min(range.end + offset, unit.text.length)
      if (start < end) {
        ranges.push({ start, end })
      }
    }
  }
  if (!ranges.length) {
    return []
  }
  return [{ ...unit, ranges: mergeMatchRanges(ranges) }]
}

export function buildRangesByField(
  assignments: readonly PaletteTokenAssignment[]
): Map<string, readonly MatchRange[]> {
  const byField = new Map<string, MatchRange[]>()
  for (const assignment of assignments) {
    const bucket = byField.get(assignment.fieldId)
    if (bucket) {
      bucket.push(...assignment.ranges)
    } else {
      byField.set(assignment.fieldId, [...assignment.ranges])
    }
  }
  return new Map([...byField].map(([id, ranges]) => [id, mergeMatchRanges(ranges)]))
}

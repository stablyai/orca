import {
  indexPaletteFields,
  type PaletteFieldSource,
  type PaletteEvidenceFieldSource as IndexedPaletteEvidenceFieldSource,
  type PaletteIndexedField
} from './indexed-field'
import type { MatchRange } from './normalized-text'
import type { PaletteMatchQuality, PaletteResultQualityClass } from './match-quality'

/**
 * A renderable proof unit. Every accepted token must land on a visible identity
 * field or on one of these, so a row can always explain itself.
 */
export type PaletteEvidenceUnit = {
  id: string
  kind: string
  /** Text the row renders for this unit; field ranges are offset into it. */
  text: string
  accessibilityLabel: string
}

export type PaletteEvidenceFieldSource = IndexedPaletteEvidenceFieldSource & {
  /** Offset of this field's text inside its unit's rendered text. */
  renderOffset: number
}

/**
 * A `left/right` token may cover two visible fields at once, e.g. `orca/main`
 * meaning repo + branch. Both halves must hit or the token falls back to a
 * literal match inside one field.
 */
export type PaletteCompositePair = { leftFieldId: string; rightFieldId: string }

export type PaletteDocument = {
  id: string
  fields: readonly PaletteIndexedField[]
  compositePairs: readonly PaletteCompositePair[]
  evidenceUnits: ReadonlyMap<string, PaletteEvidenceUnit>
  renderOffsetByFieldId: ReadonlyMap<string, number>
  /** Visible identity fields, cached because they carry the whole-query check. */
  visibleFields: readonly PaletteIndexedField[]
  fieldById: ReadonlyMap<string, PaletteIndexedField>
}

export type PaletteDocumentInput = {
  id: string
  visibleFields: readonly (PaletteFieldSource | null | undefined)[]
  compositePairs?: readonly PaletteCompositePair[]
  evidence: readonly {
    unit: PaletteEvidenceUnit
    fields: readonly (PaletteEvidenceFieldSource | null | undefined)[]
  }[]
}

export function buildPaletteDocument(input: PaletteDocumentInput): PaletteDocument {
  const evidenceSources: PaletteEvidenceFieldSource[] = []
  const evidenceUnits = new Map<string, PaletteEvidenceUnit>()
  const renderOffsetByFieldId = new Map<string, number>()

  for (const entry of input.evidence) {
    const fields = entry.fields.filter((field): field is PaletteEvidenceFieldSource =>
      Boolean(field?.text.trim())
    )
    if (!fields.length) {
      continue
    }
    // Why first-wins, matching indexPaletteFields: it keeps the first entry's fields, so
    // overwriting the unit here would pair one record's rendered text with another's
    // match offsets — highlights landing outside the string the row actually shows.
    if (evidenceUnits.has(entry.unit.id)) {
      continue
    }
    evidenceUnits.set(entry.unit.id, entry.unit)
    for (const field of fields) {
      evidenceSources.push(field)
      if (!renderOffsetByFieldId.has(field.id)) {
        renderOffsetByFieldId.set(field.id, field.renderOffset)
      }
    }
  }

  const fields = indexPaletteFields([...input.visibleFields, ...evidenceSources])
  const visibleFields: PaletteIndexedField[] = []
  const fieldById = new Map<string, PaletteIndexedField>()
  for (const field of fields) {
    fieldById.set(field.id, field)
    if (!field.evidenceId) {
      visibleFields.push(field)
    }
  }

  const fieldIds = new Set(fields.map((field) => field.id))
  return {
    id: input.id,
    fields,
    compositePairs: (input.compositePairs ?? []).filter(
      (pair) => fieldIds.has(pair.leftFieldId) && fieldIds.has(pair.rightFieldId)
    ),
    evidenceUnits,
    renderOffsetByFieldId,
    visibleFields,
    fieldById
  }
}

export type PaletteTokenAssignment = {
  tokenIndex: number
  fieldId: string
  quality: PaletteMatchQuality
  ranges: readonly MatchRange[]
}

export type PaletteSupportingEvidence = {
  id: string
  kind: string
  text: string
  ranges: readonly MatchRange[]
  accessibilityLabel: string
}

export type PaletteDocumentRank = {
  /** 0 recognized destination, 1 eligible equality, 2 structured, 3 fallback. */
  destination: number
  recovery: number
  wordMatch: number
  coverage: number
  /** Tokens proved only by container fields; fewer preserves direct-match relevance. */
  containerOnlyTokenCount: number
  /** Tokens that required compact or typo recovery; fewer breaks equal-severity ties. */
  recoveryTokenCount: number
  strength: number
  /** 0 prefix, 1 later word boundary, 2 distributed/other. */
  placement: number
}

export type PaletteDocumentMatch = {
  qualityClass: PaletteResultQualityClass
  rank: PaletteDocumentRank
  assignments: readonly PaletteTokenAssignment[]
  rangesByField: ReadonlyMap<string, readonly MatchRange[]>
  supportingEvidence: readonly PaletteSupportingEvidence[]
}

const RANK_KEYS: readonly (keyof PaletteDocumentRank)[] = [
  'destination',
  'recovery',
  'wordMatch',
  'coverage',
  'containerOnlyTokenCount',
  'recoveryTokenCount',
  'strength',
  'placement'
]

const SEMANTIC_RANK_KEYS: readonly (keyof PaletteDocumentRank)[] = [
  'destination',
  'recovery',
  'wordMatch',
  'coverage',
  'containerOnlyTokenCount',
  'recoveryTokenCount',
  'strength'
]

function compareRankKeys(
  a: PaletteDocumentRank,
  b: PaletteDocumentRank,
  keys: readonly (keyof PaletteDocumentRank)[]
): number {
  for (const key of keys) {
    const difference = a[key] - b[key]
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

export function comparePaletteSemanticRank(a: PaletteDocumentRank, b: PaletteDocumentRank): number {
  return compareRankKeys(a, b, SEMANTIC_RANK_KEYS)
}

export function comparePaletteDocumentRank(a: PaletteDocumentRank, b: PaletteDocumentRank): number {
  return compareRankKeys(a, b, RANK_KEYS)
}

export function createRecognizedPaletteRank(): PaletteDocumentRank {
  return {
    destination: 0,
    recovery: 0,
    wordMatch: 0,
    coverage: 0,
    containerOnlyTokenCount: 0,
    recoveryTokenCount: 0,
    strength: 0,
    placement: 0
  }
}

export function createPaletteFallbackRank(): PaletteDocumentRank {
  return {
    destination: 3,
    recovery: 0,
    wordMatch: 0,
    coverage: 0,
    containerOnlyTokenCount: 0,
    recoveryTokenCount: 0,
    strength: 0,
    placement: 0
  }
}

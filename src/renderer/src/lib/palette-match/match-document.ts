import { matchPaletteField, type PaletteFieldMatch } from './match-field'
import { resolvePaletteResultQualityClass, type PaletteMatchQuality } from './match-quality'
import { createPaletteQueryToken, type PaletteQueryToken } from './palette-query'
import {
  comparePaletteDocumentRank,
  type PaletteDocument,
  type PaletteDocumentMatch,
  type PaletteTokenAssignment
} from './palette-document'
import type { PaletteIndexedField } from './indexed-field'
import {
  addRankedAssignment,
  collectCompleteVisibleAssignments,
  collectRecognizedIdentifierAssignments,
  collectScopeAssignments,
  selectThresholdAssignment,
  summarizeCandidates,
  type RankedAssignment
} from './palette-assignment-ranking'
import { buildRangesByField, buildSupportingEvidence } from './palette-match-rendering'
import { assignmentsAreContainerOnly } from './palette-assignment-inspection'
import { compareSelectedSourceOrder } from './palette-selection-source-order'

type FieldHit = { field: PaletteIndexedField; match: PaletteFieldMatch }

/** One token's proof; a repo/branch composite deliberately retains both hits. */
export type TokenCandidate = {
  hits: readonly FieldHit[]
  quality: PaletteMatchQuality
  recovery: number
  wordMatch: number
  coverage: number
  strength: number
  containerOnly: number
}

export type TokenCandidates = {
  visible: TokenCandidate[]
  byEvidenceId: Map<string, TokenCandidate[]>
}

export type PaletteMatchDiagnostics = {
  selectionCandidateVisits: number
}

const STRENGTH: Record<PaletteMatchQuality, number> = {
  'field-exact': 0,
  'word-exact': 0,
  'field-prefix': 1,
  'word-prefix': 1,
  'boundary-substring': 2,
  'literal-substring': 3,
  compact: 4,
  typo: 5
}

function fieldCoverage(field: PaletteIndexedField): number {
  if (field.evidenceId) {
    return 3
  }
  if (field.role === 'primary') {
    return 0
  }
  if (field.role === 'secondary' || field.role === 'alias') {
    return 1
  }
  return 2
}

function toCandidate(hits: readonly FieldHit[]): TokenCandidate {
  let quality = hits[0].match.quality
  let strength = STRENGTH[quality]
  let recovery = strength >= STRENGTH.compact ? 1 : 0
  let wordMatch = strength >= STRENGTH['literal-substring'] ? 1 : 0
  let coverage = fieldCoverage(hits[0].field)
  for (let index = 1; index < hits.length; index += 1) {
    const hit = hits[index]
    const value = STRENGTH[hit.match.quality]
    if (value > strength) {
      strength = value
      quality = hit.match.quality
    }
    if (value >= STRENGTH.compact) {
      recovery = 1
    }
    if (value >= STRENGTH['literal-substring']) {
      wordMatch = 1
    }
    coverage = Math.max(coverage, fieldCoverage(hit.field))
  }
  return {
    hits,
    quality,
    recovery,
    wordMatch,
    coverage,
    containerOnly: hits.every((hit) => hit.field.role === 'container') ? 1 : 0,
    strength
  }
}

function matchCompositePairs(
  document: PaletteDocument,
  token: PaletteQueryToken,
  isFieldAllowed?: (field: PaletteIndexedField) => boolean
): TokenCandidate[] {
  if (!token.repoBranch || !document.compositePairs.length) {
    return []
  }
  const left = createPaletteQueryToken(token.repoBranch.repo, token.index)
  const right = createPaletteQueryToken(token.repoBranch.branch, token.index)
  const candidates: TokenCandidate[] = []
  for (const pair of document.compositePairs) {
    const leftField = document.fieldById.get(pair.leftFieldId)
    const rightField = document.fieldById.get(pair.rightFieldId)
    if (
      !leftField ||
      !rightField ||
      (isFieldAllowed && (!isFieldAllowed(leftField) || !isFieldAllowed(rightField)))
    ) {
      continue
    }
    const leftMatch = matchPaletteField(leftField, left)
    const rightMatch = matchPaletteField(rightField, right)
    if (leftMatch && rightMatch) {
      candidates.push(
        toCandidate([
          { field: leftField, match: leftMatch },
          { field: rightField, match: rightMatch }
        ])
      )
    }
  }
  return candidates
}

function collectTokenCandidates(
  document: PaletteDocument,
  token: PaletteQueryToken,
  isFieldAllowed?: (field: PaletteIndexedField) => boolean
): TokenCandidates | null {
  const candidates: TokenCandidates = {
    visible: matchCompositePairs(document, token, isFieldAllowed),
    byEvidenceId: new Map()
  }
  let found = candidates.visible.length > 0
  for (const field of document.fields) {
    if (isFieldAllowed && !isFieldAllowed(field)) {
      continue
    }
    const match = matchPaletteField(field, token)
    if (!match) {
      continue
    }
    found = true
    const candidate = toCandidate([{ field, match }])
    if (!field.evidenceId) {
      candidates.visible.push(candidate)
    } else {
      const bucket = candidates.byEvidenceId.get(field.evidenceId)
      if (bucket) {
        bucket.push(candidate)
      } else {
        candidates.byEvidenceId.set(field.evidenceId, [candidate])
      }
    }
  }
  return found ? candidates : null
}

function toTokenAssignments(
  tokens: readonly PaletteQueryToken[],
  selected: readonly TokenCandidate[]
): PaletteTokenAssignment[] {
  const assignments: PaletteTokenAssignment[] = []
  selected.forEach((candidate, index) => {
    for (const hit of candidate.hits) {
      assignments.push({
        tokenIndex: tokens[index].index,
        fieldId: hit.field.id,
        quality: hit.match.quality,
        ranges: hit.match.ranges
      })
    }
  })
  return assignments
}

export function matchPaletteDocument(args: {
  document: PaletteDocument
  tokens: readonly PaletteQueryToken[]
  normalizedQuery: string
  tokenCountBeforeDeduplication?: number
  exactIntent?: boolean
  isFieldAllowed?: (field: PaletteIndexedField) => boolean
  diagnostics?: PaletteMatchDiagnostics
}): PaletteDocumentMatch | null {
  const candidates: TokenCandidates[] = []
  for (const token of args.tokens) {
    const collected = collectTokenCandidates(args.document, token, args.isFieldAllowed)
    if (!collected) {
      return null
    }
    candidates.push(collected)
  }

  const visibleSummaries = candidates.map((candidate) =>
    summarizeCandidates(candidate.visible, args.diagnostics)
  )
  const evidenceSummaries = candidates.map(
    (candidate) =>
      new Map(
        [...candidate.byEvidenceId].map(([evidenceId, entries]) => [
          evidenceId,
          summarizeCandidates(entries, args.diagnostics)
        ])
      )
  )
  const ranked: RankedAssignment[] = [
    ...collectCompleteVisibleAssignments({
      document: args.document,
      candidates,
      normalizedQuery: args.normalizedQuery,
      diagnostics: args.diagnostics
    })
  ]
  addRankedAssignment(
    ranked,
    args.document,
    selectThresholdAssignment(visibleSummaries, args.diagnostics),
    args.normalizedQuery,
    null
  )
  const matchedEvidenceIds = new Set<string>()
  for (const candidate of candidates) {
    for (const evidenceId of candidate.byEvidenceId.keys()) {
      matchedEvidenceIds.add(evidenceId)
    }
  }
  for (const evidenceId of matchedEvidenceIds) {
    ranked.push(
      ...collectScopeAssignments({
        document: args.document,
        visibleSummaries,
        evidenceSummaries,
        normalizedQuery: args.normalizedQuery,
        evidenceId,
        diagnostics: args.diagnostics
      })
    )
  }
  if ((args.tokenCountBeforeDeduplication ?? args.tokens.length) === 1) {
    ranked.push(
      ...collectRecognizedIdentifierAssignments({
        document: args.document,
        candidates,
        normalizedQuery: args.normalizedQuery,
        diagnostics: args.diagnostics
      })
    )
  }
  if (!ranked.length) {
    return null
  }
  ranked.sort((a, b) => {
    const rank = comparePaletteDocumentRank(a.rank, b.rank)
    if (rank !== 0) {
      return rank
    }
    return compareSelectedSourceOrder(a.selected, b.selected)
  })
  const winner = ranked[0]
  const winnerRank = args.exactIntent ? { ...winner.rank, destination: 0 } : winner.rank
  const assignments = toTokenAssignments(args.tokens, winner.selected)
  const worstQuality = winner.selected.reduce<PaletteMatchQuality>(
    (worst, candidate) =>
      STRENGTH[candidate.quality] > STRENGTH[worst] ? candidate.quality : worst,
    'field-exact'
  )
  const usesSupportingEvidence = assignments.some(
    (assignment) => args.document.fieldById.get(assignment.fieldId)?.evidenceId
  )
  return {
    qualityClass:
      winnerRank.destination === 0
        ? 'exact-intent'
        : resolvePaletteResultQualityClass({
            worstQuality,
            usesSupportingEvidence,
            isContainerOnly: assignmentsAreContainerOnly(args.document, assignments)
          }),
    rank: winnerRank,
    assignments,
    rangesByField: buildRangesByField(assignments),
    supportingEvidence: buildSupportingEvidence(args.document, assignments, winner.evidenceId)
  }
}

import type { PaletteDocument, PaletteDocumentRank } from './palette-document'
import type { PaletteIndexedField } from './indexed-field'
import type { PaletteMatchDiagnostics, TokenCandidate, TokenCandidates } from './match-document'

type CandidateMetric = 'recovery' | 'wordMatch' | 'coverage' | 'strength'

const METRIC_KEYS: readonly CandidateMetric[] = ['recovery', 'wordMatch', 'coverage', 'strength']

function phrasePlacement(field: PaletteIndexedField, normalizedQuery: string): number {
  const text = field.text.normalized
  if (text.startsWith(normalizedQuery)) {
    return 0
  }
  let index = text.indexOf(normalizedQuery, 1)
  while (index !== -1) {
    if (field.words.some((word) => word.start === index)) {
      return 1
    }
    index = text.indexOf(normalizedQuery, index + 1)
  }
  return 2
}

export function selectThresholdAssignment(
  candidates: readonly TokenCandidate[][],
  diagnostics?: PaletteMatchDiagnostics
): TokenCandidate[] | null {
  if (candidates.some((entries) => entries.length === 0)) {
    return null
  }
  let remaining = candidates.map((entries) => [...entries])
  for (const key of METRIC_KEYS) {
    let optimum = 0
    for (const entries of remaining) {
      let minimum = Number.POSITIVE_INFINITY
      for (const candidate of entries) {
        if (diagnostics) {
          diagnostics.selectionCandidateVisits += 1
        }
        minimum = Math.min(minimum, candidate[key])
      }
      optimum = Math.max(optimum, minimum)
    }
    remaining = remaining.map((entries) =>
      entries.filter((candidate) => {
        if (diagnostics) {
          diagnostics.selectionCandidateVisits += 1
        }
        return candidate[key] <= optimum
      })
    )
  }
  return remaining.map((entries) => entries[0])
}

function candidateMetricKey(candidate: TokenCandidate): number {
  return (
    (((candidate.recovery * 2 + candidate.wordMatch) * 4 + candidate.coverage) * 6 +
      candidate.strength) |
    0
  )
}

export function summarizeCandidates(
  candidates: readonly TokenCandidate[],
  diagnostics?: PaletteMatchDiagnostics
): TokenCandidate[] {
  const byMetric = new Map<number, TokenCandidate>()
  for (const candidate of candidates) {
    if (diagnostics) {
      diagnostics.selectionCandidateVisits += 1
    }
    const key = candidateMetricKey(candidate)
    if (!byMetric.has(key)) {
      byMetric.set(key, candidate)
    }
  }
  return [...byMetric.values()]
}

function assignmentPlacement(
  document: PaletteDocument,
  selected: readonly TokenCandidate[],
  normalizedQuery: string
): number {
  const fieldId = selected[0]?.hits.length === 1 ? selected[0].hits[0].field.id : null
  if (!fieldId) {
    return 2
  }
  if (
    selected.some(
      (candidate) => candidate.hits.length !== 1 || candidate.hits[0].field.id !== fieldId
    )
  ) {
    return 2
  }
  const field = document.fieldById.get(fieldId)
  return field && !field.evidenceId ? phrasePlacement(field, normalizedQuery) : 2
}

function rankSelected(
  selected: readonly TokenCandidate[],
  destination: number,
  placement: number
): PaletteDocumentRank {
  return {
    destination,
    recovery: Math.max(...selected.map((candidate) => candidate.recovery)),
    wordMatch: Math.max(...selected.map((candidate) => candidate.wordMatch)),
    coverage: Math.max(...selected.map((candidate) => candidate.coverage)),
    strength: Math.max(...selected.map((candidate) => candidate.strength)),
    placement
  }
}

function candidateProofIdentity(selected: readonly TokenCandidate[]): string {
  return selected.map((candidate) => candidate.identity).join('\u0001')
}

export type RankedAssignment = {
  selected: readonly TokenCandidate[]
  rank: PaletteDocumentRank
  evidenceId: string | null
  proofIdentity: string
}

export function addRankedAssignment(
  target: RankedAssignment[],
  document: PaletteDocument,
  selected: readonly TokenCandidate[] | null,
  normalizedQuery: string,
  evidenceId: string | null,
  destination = 2
): void {
  if (!selected) {
    return
  }
  target.push({
    selected,
    rank: rankSelected(
      selected,
      destination,
      assignmentPlacement(document, selected, normalizedQuery)
    ),
    evidenceId,
    proofIdentity: candidateProofIdentity(selected)
  })
}

export function collectScopeAssignments(args: {
  document: PaletteDocument
  visibleSummaries: readonly TokenCandidate[][]
  evidenceSummaries: ReadonlyMap<string, readonly TokenCandidate[]>[]
  normalizedQuery: string
  evidenceId: string
  diagnostics?: PaletteMatchDiagnostics
}): RankedAssignment[] {
  const scopeCandidates = args.visibleSummaries.map((visible, index) =>
    summarizeCandidates(
      [...visible, ...(args.evidenceSummaries[index].get(args.evidenceId) ?? [])],
      args.diagnostics
    )
  )
  const assignments: RankedAssignment[] = []
  addRankedAssignment(
    assignments,
    args.document,
    selectThresholdAssignment(scopeCandidates, args.diagnostics),
    args.normalizedQuery,
    args.evidenceId
  )
  return assignments
}

export function collectCompleteVisibleAssignments(args: {
  document: PaletteDocument
  candidates: readonly TokenCandidates[]
  normalizedQuery: string
  diagnostics?: PaletteMatchDiagnostics
}): RankedAssignment[] {
  const candidateByField = args.candidates.map((tokenCandidates) => {
    const byField = new Map<string, TokenCandidate>()
    for (const candidate of tokenCandidates.visible) {
      if (args.diagnostics) {
        args.diagnostics.selectionCandidateVisits += 1
      }
      if (candidate.hits.length === 1) {
        byField.set(candidate.hits[0].field.id, candidate)
      }
    }
    return byField
  })
  const assignments: RankedAssignment[] = []
  for (const field of args.document.visibleFields) {
    const selected = candidateByField.map((byField) => byField.get(field.id))
    if (selected.some((candidate) => !candidate)) {
      continue
    }
    addRankedAssignment(
      assignments,
      args.document,
      selected as TokenCandidate[],
      args.normalizedQuery,
      null,
      field.destinationEligible && field.text.normalized === args.normalizedQuery ? 1 : 2
    )
  }
  return assignments
}

export function collectRecognizedIdentifierAssignments(args: {
  document: PaletteDocument
  candidates: readonly TokenCandidates[]
  normalizedQuery: string
  diagnostics?: PaletteMatchDiagnostics
}): RankedAssignment[] {
  const assignments: RankedAssignment[] = []
  for (const tokenCandidates of args.candidates) {
    for (const entries of [tokenCandidates.visible, ...tokenCandidates.byEvidenceId.values()]) {
      for (const candidate of entries) {
        if (args.diagnostics) {
          args.diagnostics.selectionCandidateVisits += 1
        }
        if (candidate.hits.length !== 1) {
          continue
        }
        const field = candidate.hits[0].field
        if (
          field?.identifier?.kind === 'number' &&
          field.text.normalized === args.normalizedQuery &&
          candidate.hits[0].match.quality === 'field-exact' &&
          field.identifier.sigil === args.normalizedQuery[0]
        ) {
          addRankedAssignment(
            assignments,
            args.document,
            [candidate],
            args.normalizedQuery,
            field.evidenceId,
            0
          )
        }
      }
    }
  }
  return assignments
}

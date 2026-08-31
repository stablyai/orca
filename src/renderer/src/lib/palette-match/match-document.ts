import { matchPaletteField, type PaletteFieldMatch } from './match-field'
import {
  isFuzzyPaletteMatchQuality,
  paletteMatchQualityRank,
  resolvePaletteResultQualityClass,
  type PaletteMatchQuality
} from './match-quality'
import { mergeMatchRanges, type MatchRange } from './normalized-text'
import { createPaletteQueryToken, type PaletteQueryToken } from './palette-query'
import {
  comparePaletteDocumentRank,
  type PaletteDocument,
  type PaletteDocumentMatch,
  type PaletteDocumentRank,
  type PaletteSupportingEvidence,
  type PaletteTokenAssignment
} from './palette-document'

type FieldHit = { fieldId: string; match: PaletteFieldMatch }

/** One token's chosen coverage; a `repo/branch` composite carries two hits. */
type TokenCandidate = { hits: readonly FieldHit[]; quality: PaletteMatchQuality }

type TokenCandidates = {
  visible: TokenCandidate | null
  byEvidenceId: Map<string, TokenCandidate>
}

function better(a: TokenCandidate | null, b: TokenCandidate): TokenCandidate {
  if (!a) {
    return b
  }
  return paletteMatchQualityRank(a.quality) <= paletteMatchQualityRank(b.quality) ? a : b
}

function toCandidate(hits: readonly FieldHit[]): TokenCandidate {
  let quality = hits[0].match.quality
  for (const hit of hits) {
    if (paletteMatchQualityRank(hit.match.quality) > paletteMatchQualityRank(quality)) {
      quality = hit.match.quality
    }
  }
  return { hits, quality }
}

function matchCompositePairs(
  document: PaletteDocument,
  token: PaletteQueryToken
): TokenCandidate | null {
  if (!token.repoBranch || !document.compositePairs.length) {
    return null
  }
  const left = createPaletteQueryToken(token.repoBranch.repo, token.index)
  const right = createPaletteQueryToken(token.repoBranch.branch, token.index)
  let best: TokenCandidate | null = null
  for (const pair of document.compositePairs) {
    const leftField = document.fields.find((field) => field.id === pair.leftFieldId)
    const rightField = document.fields.find((field) => field.id === pair.rightFieldId)
    if (!leftField || !rightField) {
      continue
    }
    const leftMatch = matchPaletteField(leftField, left)
    const rightMatch = matchPaletteField(rightField, right)
    if (!leftMatch || !rightMatch) {
      continue
    }
    best = better(
      best,
      toCandidate([
        { fieldId: leftField.id, match: leftMatch },
        { fieldId: rightField.id, match: rightMatch }
      ])
    )
  }
  return best
}

function collectTokenCandidates(
  document: PaletteDocument,
  token: PaletteQueryToken
): TokenCandidates | null {
  const candidates: TokenCandidates = {
    visible: matchCompositePairs(document, token),
    byEvidenceId: new Map()
  }
  let found = candidates.visible !== null
  for (const field of document.fields) {
    const match = matchPaletteField(field, token)
    if (!match) {
      continue
    }
    found = true
    const candidate = toCandidate([{ fieldId: field.id, match }])
    if (!field.evidenceId) {
      candidates.visible = better(candidates.visible, candidate)
    } else {
      candidates.byEvidenceId.set(
        field.evidenceId,
        better(candidates.byEvidenceId.get(field.evidenceId) ?? null, candidate)
      )
    }
  }
  return found ? candidates : null
}

function scoreWholeQuery(document: PaletteDocument, normalizedQuery: string): number {
  let best = 3
  for (const field of document.visibleFields) {
    const text = field.text.normalized
    if (text === normalizedQuery) {
      return 0
    }
    if (text.startsWith(normalizedQuery)) {
      best = Math.min(best, 1)
      continue
    }
    const index = text.indexOf(normalizedQuery)
    if (index > 0 && field.words.some((word) => word.start === index)) {
      best = Math.min(best, 2)
    }
  }
  return best
}

function buildAssignments(
  candidates: readonly TokenCandidates[],
  tokens: readonly PaletteQueryToken[],
  evidenceId: string | null
): { assignments: PaletteTokenAssignment[]; usesEvidence: boolean } | null {
  const assignments: PaletteTokenAssignment[] = []
  let usesEvidence = false

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]
    const evidence = evidenceId ? (candidate.byEvidenceId.get(evidenceId) ?? null) : null
    const chosen = evidence ? better(candidate.visible, evidence) : candidate.visible
    if (!chosen) {
      return null
    }
    if (evidence && chosen === evidence) {
      usesEvidence = true
    }
    for (const hit of chosen.hits) {
      assignments.push({
        tokenIndex: tokens[index].index,
        fieldId: hit.fieldId,
        quality: hit.match.quality,
        ranges: hit.match.ranges
      })
    }
  }

  return { assignments, usesEvidence }
}

function rankAssignments(args: {
  document: PaletteDocument
  assignments: readonly PaletteTokenAssignment[]
  usesEvidence: boolean
  wholeQuery: number
  exactIntent: boolean
}): { rank: PaletteDocumentRank; worstQuality: PaletteMatchQuality; isContainerOnly: boolean } {
  let worstQuality: PaletteMatchQuality = 'field-exact'
  let fuzzyTokenCount = 0
  const fields = new Set<string>()
  let containerOnlyTokenCount = 0
  let tokenIndex = -1
  let tokenHasDirectField = false
  let matchedTokenCount = 0

  for (const assignment of args.assignments) {
    if (paletteMatchQualityRank(assignment.quality) > paletteMatchQualityRank(worstQuality)) {
      worstQuality = assignment.quality
    }
    if (isFuzzyPaletteMatchQuality(assignment.quality)) {
      fuzzyTokenCount += 1
    }
    fields.add(assignment.fieldId)
    if (assignment.tokenIndex !== tokenIndex) {
      if (tokenIndex !== -1 && !tokenHasDirectField) {
        containerOnlyTokenCount += 1
      }
      tokenIndex = assignment.tokenIndex
      tokenHasDirectField = false
      matchedTokenCount += 1
    }
    const field = args.document.fieldById.get(assignment.fieldId)
    if (field && !field.isContainer) {
      tokenHasDirectField = true
    }
  }

  if (tokenIndex !== -1 && !tokenHasDirectField) {
    containerOnlyTokenCount += 1
  }
  const isContainerOnly =
    containerOnlyTokenCount > 0 && containerOnlyTokenCount === matchedTokenCount

  return {
    worstQuality,
    isContainerOnly,
    rank: {
      exactIntent: args.exactIntent ? 0 : 1,
      containerOnlyTokenCount,
      wholeQuery: args.wholeQuery,
      worstQuality: paletteMatchQualityRank(worstQuality),
      usesSupportingEvidence: args.usesEvidence ? 1 : 0,
      fuzzyTokenCount,
      fieldHopCount: fields.size
    }
  }
}

function buildSupportingEvidence(
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
      // Why clamp: a range is only meaningful against the unit text the row renders, and
      // an out-of-range end would highlight past the end of that string.
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
  return [
    {
      id: unit.id,
      kind: unit.kind,
      text: unit.text,
      ranges: mergeMatchRanges(ranges),
      accessibilityLabel: unit.accessibilityLabel
    }
  ]
}

function buildRangesByField(
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
  const merged = new Map<string, readonly MatchRange[]>()
  for (const [fieldId, ranges] of byField) {
    merged.set(fieldId, mergeMatchRanges(ranges))
  }
  return merged
}

/**
 * Accepts a document only when every token has an allowed field match reachable
 * from visible identity text plus at most one supporting-evidence unit.
 */
export function matchPaletteDocument(args: {
  document: PaletteDocument
  tokens: readonly PaletteQueryToken[]
  normalizedQuery: string
  exactIntent?: boolean
}): PaletteDocumentMatch | null {
  const { document, tokens } = args
  const candidates: TokenCandidates[] = []
  for (const token of tokens) {
    const candidate = collectTokenCandidates(document, token)
    if (!candidate) {
      return null
    }
    candidates.push(candidate)
  }

  const wholeQuery = scoreWholeQuery(document, args.normalizedQuery)
  const evidenceIds: (string | null)[] = [null, ...document.evidenceUnits.keys()]
  let best: PaletteDocumentMatch | null = null

  for (const evidenceId of evidenceIds) {
    const built = buildAssignments(candidates, tokens, evidenceId)
    if (!built) {
      continue
    }
    const usedEvidenceId = built.usesEvidence ? evidenceId : null
    const { rank, worstQuality, isContainerOnly } = rankAssignments({
      document,
      assignments: built.assignments,
      usesEvidence: built.usesEvidence,
      wholeQuery,
      exactIntent: args.exactIntent === true
    })
    if (best && comparePaletteDocumentRank(best.rank, rank) <= 0) {
      continue
    }
    best = {
      qualityClass: args.exactIntent
        ? 'exact-intent'
        : resolvePaletteResultQualityClass({
            worstQuality,
            usesSupportingEvidence: built.usesEvidence,
            isContainerOnly
          }),
      rank,
      assignments: built.assignments,
      rangesByField: buildRangesByField(built.assignments),
      supportingEvidence: buildSupportingEvidence(document, built.assignments, usedEvidenceId)
    }
  }

  return best
}

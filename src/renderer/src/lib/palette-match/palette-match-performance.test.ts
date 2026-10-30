import { beforeAll, describe, expect, it, vi } from 'vitest'
import { PALETTE_MATCH_BUDGET } from '../../../../shared/palette-match/palette-match-budget'
import {
  matchPaletteDocument,
  type PaletteMatchDiagnostics
} from '../../../../shared/palette-match/match-document'
import * as matchFieldModule from '../../../../shared/palette-match/match-field'
import { preparePaletteQuery } from '../../../../shared/palette-match/palette-query'
import { buildWorktreePaletteDocuments } from '../worktree-palette-document'
import { searchWorktreeDocuments } from '../worktree-palette-search'
import {
  comparePaletteEntityRanks,
  createPaletteSearchContext
} from '../../../../shared/palette-match/palette-ranking'
import {
  buildPaletteDocument,
  type PaletteDocument
} from '../../../../shared/palette-match/palette-document'
import type { PaletteQueryToken } from '../../../../shared/palette-match/palette-query'
import { issueCacheKey } from '@/store/github/cache-identity'
import { getPaletteWorktreeIdentity } from '../palette-repo-resolution'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

const { candidateCount, tokenCount } = PALETTE_MATCH_BUDGET
const QUERY_TOKENS = Array.from({ length: tokenCount }, (_, index) => `token${index}`)
const QUERY_TEXT = QUERY_TOKENS.join(' ')

const LONG_COMMENT =
  `Blocked on the staging relay while the host reconnects; see the runbook for the escalation path and the rollback steps before retrying the deploy. `.repeat(
    6
  )

const repoMap: ReadonlyMap<string, Repo> = new Map([
  [
    'repo-1',
    {
      id: 'repo-1',
      path: '/repos/orca',
      displayName: 'acme/orca',
      badgeColor: '#22c55e',
      addedAt: 0
    }
  ]
])

function makeWorktree(index: number): Worktree {
  return {
    id: `wt-${index}`,
    repoId: 'repo-1',
    path: `/work/wt-${index}`,
    head: `${index}`.padStart(7, 'a'),
    branch: `refs/heads/${QUERY_TOKENS.join('-')}`,
    isBare: false,
    isMainWorktree: false,
    displayName: `${QUERY_TEXT} workspace ${index}`,
    comment: `${QUERY_TEXT}. ${LONG_COMMENT}`,
    linkedIssue: 1000 + index,
    linkedPR: 2000 + index,
    linkedLinearIssue: `ORC-${index}`,
    linkedWorkItem: {
      provider: 'linear',
      type: 'issue',
      number: index,
      title: `${QUERY_TEXT} work item ${index}`,
      url: `https://linear.app/acme/issue/ORC-${index}`,
      linearIdentifier: `ORC-${index}`
    },
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'auto-1',
      automationNameSnapshot: 'Nightly review',
      automationRunId: `run-${index}`,
      automationRunTitleSnapshot: `${QUERY_TEXT} sweep ${index}`,
      createdAt: Date.UTC(2026, 7, 13),
      executionTargetType: 'local',
      executionTargetId: 'repo-1',
      projectId: 'project-1'
    },
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: index,
    lastActivityAt: index
  }
}

const worktrees = Array.from({ length: candidateCount }, (_, index) => makeWorktree(index))
const ports = new Map(
  worktrees.map((worktree, index) => [worktree.id, [{ port: 3000 + index, processName: 'node' }]])
)
const issueCache = Object.fromEntries(
  worktrees.map((worktree, index) => [
    issueCacheKey('/repos/orca', worktree.repoId, 1000 + index),
    { data: { number: 1000 + index, title: `${QUERY_TEXT} issue ${index}` } }
  ])
)

const sources = {
  repoMap,
  issueCache,
  workspacePortsByWorktreeId: ports,
  hostLabelByWorktreeId: new Map(worktrees.map((worktree) => [worktree.id, QUERY_TEXT]))
}

const WORST_QUERY = QUERY_TEXT

function prepareWorstQuery(): { tokens: readonly PaletteQueryToken[]; normalized: string } {
  const prepared = preparePaletteQuery(WORST_QUERY)
  if (prepared.state !== 'ready') {
    throw new Error(`Expected a ready query, got ${prepared.state}`)
  }
  return { tokens: prepared.tokens, normalized: prepared.normalized }
}

const preparedQuery = prepareWorstQuery()

function matchEveryDocument(
  documents: ReadonlyMap<string, PaletteDocument>,
  diagnostics?: PaletteMatchDiagnostics
): ReturnType<typeof matchPaletteDocument>[] {
  const matches: ReturnType<typeof matchPaletteDocument>[] = []
  for (const document of documents.values()) {
    matches.push(
      matchPaletteDocument({
        document,
        tokens: preparedQuery.tokens,
        normalizedQuery: preparedQuery.normalized,
        diagnostics
      })
    )
  }
  return matches
}

function retainedMatchPayloadBytes(matches: ReturnType<typeof matchPaletteDocument>[]): number {
  let bytes = 0
  for (const match of matches) {
    if (!match) {
      continue
    }
    for (const assignment of match.assignments) {
      bytes += assignment.fieldId.length * 2 + 16
      bytes += assignment.ranges.length * 16
    }
    for (const [fieldId, ranges] of match.rangesByField) {
      bytes += fieldId.length * 2 + ranges.length * 16
    }
    for (const evidence of match.supportingEvidence) {
      bytes += (evidence.id.length + evidence.kind.length + evidence.text.length) * 2
      bytes += evidence.ranges.length * 16
    }
  }
  return bytes
}

// Use fastest samples to reduce worker-preemption noise; deterministic counters separately catch work fan-out.
function fastestSample(samples: readonly number[]): number {
  return Math.min(...samples)
}

function timeRepeatedly(work: () => void, rounds: number): number[] {
  const samples: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    work()
    samples.push(performance.now() - start)
  }
  return samples
}

// Compare full versus four quarter passes: ~1 is linear, ~4 quadratic. Alternate equal-work samples so runner-speed/contention swings affect both.
function quadrupledCorpusCostRatio(
  work: (size: 'quarter' | 'full') => void,
  rounds: number
): number {
  const quarter: number[] = []
  const full: number[] = []
  for (let round = 0; round < rounds; round += 1) {
    quarter.push(
      ...timeRepeatedly(() => {
        for (let pass = 0; pass < 4; pass += 1) {
          work('quarter')
        }
      }, 1)
    )
    full.push(...timeRepeatedly(() => work('full'), 1))
  }
  return fastestSample(full) / fastestSample(quarter)
}

function quarterOf<T>(entries: Iterable<T>): T[] {
  return [...entries].slice(0, candidateCount / 4)
}

describe('palette matcher performance budget', () => {
  let documents: ReadonlyMap<string, PaletteDocument>

  beforeAll(() => {
    documents = buildWarmDocuments()
  })

  function buildWarmDocuments(): ReadonlyMap<string, PaletteDocument> {
    const documents = buildWorktreePaletteDocuments(worktrees, sources)
    expect(documents.size).toBe(candidateCount)
    expect(preparedQuery.tokens).toHaveLength(tokenCount)
    for (const [index, worktree] of worktrees.entries()) {
      expect(
        documents
          .get(getPaletteWorktreeIdentity(worktree))
          ?.evidenceUnits.get(`issue:${1000 + index}`)?.text
      ).toContain(`${QUERY_TEXT} issue ${index}`)
    }
    return documents
  }

  it('normalizes a cold corpus within budget', () => {
    const samples = timeRepeatedly(() => buildWorktreePaletteDocuments(worktrees, sources), 5)
    expect(fastestSample(samples)).toBeLessThan(PALETTE_MATCH_BUDGET.coldBuildMs)
  })

  it('matches a 16-token query against warm documents in linear time', () => {
    const quarter = new Map(quarterOf(documents))
    // Warm the matcher before timing so JIT compilation is not part of the samples.
    expect(matchEveryDocument(documents).filter(Boolean)).toHaveLength(candidateCount)
    expect(matchEveryDocument(quarter).filter(Boolean)).toHaveLength(candidateCount / 4)

    const ratio = quadrupledCorpusCostRatio(
      (size) => matchEveryDocument(size === 'full' ? documents : quarter),
      10
    )
    expect(ratio).toBeLessThan(PALETTE_MATCH_BUDGET.quadrupledCorpusCostRatio)
  })

  it('bounds field-match fan-out per candidate', () => {
    const fieldMatch = vi.spyOn(matchFieldModule, 'matchPaletteField')
    try {
      matchEveryDocument(documents)
      const perCandidate = fieldMatch.mock.calls.length / documents.size
      // Guards the ceiling against going vacuous if the spy ever stops intercepting.
      expect(perCandidate).toBeGreaterThan(0)
      expect(perCandidate).toBeLessThan(PALETTE_MATCH_BUDGET.fieldMatchesPerCandidate)
    } finally {
      fieldMatch.mockRestore()
    }
  })

  it('bounds candidate selection work per accepted candidate', () => {
    const diagnostics: PaletteMatchDiagnostics = { selectionCandidateVisits: 0 }
    expect(matchEveryDocument(documents, diagnostics).filter(Boolean)).toHaveLength(candidateCount)
    expect(diagnostics.selectionCandidateVisits).toBeGreaterThan(0)
    expect(diagnostics.selectionCandidateVisits / documents.size).toBeLessThan(
      PALETTE_MATCH_BUDGET.selectionCandidateVisitsPerCandidate
    )
  })

  it('does not revisit an all-visible assignment for unmatched evidence units', () => {
    const buildDocument = (evidenceCount: number): PaletteDocument =>
      buildPaletteDocument({
        id: `visible-${evidenceCount}`,
        visibleFields: [
          {
            id: 'title',
            profile: 'structured-label',
            text: 'atlas',
            role: 'primary',
            destinationEligible: true
          }
        ],
        evidence: Array.from({ length: evidenceCount }, (_, index) => ({
          unit: {
            id: `evidence-${index}`,
            kind: 'comment',
            text: `unrelated ${index}`,
            accessibilityLabel: 'Comment'
          },
          fields: [
            {
              id: `evidence-field-${index}`,
              profile: 'prose' as const,
              text: `unrelated ${index}`,
              evidenceId: `evidence-${index}`,
              renderOffset: 0
            }
          ]
        }))
      })
    const query = preparePaletteQuery('atlas')
    if (query.state !== 'ready') {
      throw new Error('Expected ready query')
    }
    const selectionVisits = (document: PaletteDocument): number => {
      const diagnostics: PaletteMatchDiagnostics = { selectionCandidateVisits: 0 }
      const match = matchPaletteDocument({
        document,
        tokens: query.tokens,
        normalizedQuery: query.normalized,
        diagnostics
      })
      expect(match).not.toBeNull()
      expect(diagnostics.selectionCandidateVisits).toBeGreaterThan(0)
      return diagnostics.selectionCandidateVisits
    }

    expect(selectionVisits(buildDocument(100))).toBe(selectionVisits(buildDocument(0)))
  })

  it('does not revisit an all-visible assignment for dominated evidence matches', () => {
    const buildDocument = (evidenceCount: number): PaletteDocument =>
      buildPaletteDocument({
        id: `visible-matched-${evidenceCount}`,
        visibleFields: [
          {
            id: 'title',
            profile: 'structured-label',
            text: 'atlas',
            role: 'primary',
            destinationEligible: true
          }
        ],
        evidence: Array.from({ length: evidenceCount }, (_, index) => ({
          unit: {
            id: `evidence-${index}`,
            kind: 'comment',
            text: 'atlas',
            accessibilityLabel: 'Comment'
          },
          fields: [
            {
              id: `evidence-field-${index}`,
              profile: 'prose' as const,
              text: 'atlas',
              evidenceId: `evidence-${index}`,
              renderOffset: 0
            }
          ]
        }))
      })
    const query = preparePaletteQuery('atlas')
    if (query.state !== 'ready') {
      throw new Error('Expected ready query')
    }
    const selectionVisits = (document: PaletteDocument): number => {
      const diagnostics: PaletteMatchDiagnostics = { selectionCandidateVisits: 0 }
      const match = matchPaletteDocument({
        document,
        tokens: query.tokens,
        normalizedQuery: query.normalized,
        diagnostics
      })
      expect(match?.supportingEvidence).toEqual([])
      expect(diagnostics.selectionCandidateVisits).toBeGreaterThan(0)
      return diagnostics.selectionCandidateVisits
    }

    expect(selectionVisits(buildDocument(100))).toBe(selectionVisits(buildDocument(0)))
  })

  it('keeps retained match and range payload within budget', () => {
    const matches = matchEveryDocument(documents)
    expect(matches.filter(Boolean)).toHaveLength(candidateCount)
    expect(
      matches.every(
        (match) => match && match.assignments.length > 0 && match.rangesByField.size > 0
      )
    ).toBe(true)
    expect(retainedMatchPayloadBytes(matches) / (1024 * 1024)).toBeLessThan(
      PALETTE_MATCH_BUDGET.matchPayloadMb
    )
  })

  it('searches and sorts the accepted corpus in linear time', () => {
    const context = createPaletteSearchContext(Date.UTC(2026, 8, 5))
    const quarterWorktrees = quarterOf(worktrees)
    const searchAndSort = (searched: readonly Worktree[] = worktrees) =>
      searchWorktreeDocuments({
        worktrees: searched,
        query: WORST_QUERY,
        documents,
        repoMap,
        context
      }).sort((a, b) =>
        comparePaletteEntityRanks(
          {
            rank: a.rank!,
            activity: a.activity,
            position: 0,
            identity: `${a.worktreeHostId ?? ''}:${a.worktreeId}`
          },
          {
            rank: b.rank!,
            activity: b.activity,
            position: 0,
            identity: `${b.worktreeHostId ?? ''}:${b.worktreeId}`
          }
        )
      )
    const warmResults = searchAndSort()
    expect(warmResults).toHaveLength(candidateCount)
    expect(new Set(warmResults.map((result) => result.worktreeId)).size).toBe(candidateCount)
    expect(
      warmResults.every((result) => result.rank !== null && result.displayNameRanges.length > 0)
    ).toBe(true)
    expect(warmResults[0].worktreeId).toBe(`wt-${candidateCount - 1}`)
    expect(searchAndSort(quarterWorktrees)).toHaveLength(candidateCount / 4)
    const ratio = quadrupledCorpusCostRatio(
      (size) => searchAndSort(size === 'full' ? worktrees : quarterWorktrees),
      10
    )
    expect(ratio).toBeLessThan(PALETTE_MATCH_BUDGET.quadrupledCorpusCostRatio)
  })

  it('keeps the retained document payload within budget', () => {
    expect(documents.size).toBe(candidateCount)

    let bytes = 0
    for (const document of documents.values()) {
      for (const field of document.fields) {
        bytes += (field.text.original.length + field.text.normalized.length) * 2
        bytes += (field.text.starts?.byteLength ?? 0) + (field.text.ends?.byteLength ?? 0)
        for (const atom of field.atoms) {
          bytes += atom.compact.length * 2 + atom.compactOffsets.byteLength
        }
      }
    }
    expect(bytes / (1024 * 1024)).toBeLessThan(PALETTE_MATCH_BUDGET.documentPayloadMb)
  })
})

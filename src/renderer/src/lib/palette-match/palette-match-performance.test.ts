import { describe, expect, it, vi } from 'vitest'
import { PALETTE_MATCH_BUDGET } from './palette-match-budget'
import { matchPaletteDocument } from './match-document'
import * as matchFieldModule from './match-field'
import { preparePaletteQuery } from './palette-query'
import { buildWorktreePaletteDocuments } from '../worktree-palette-document'
import type { PaletteDocument } from './palette-document'
import type { PaletteQueryToken } from './palette-query'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

const { candidateCount, tokenCount } = PALETTE_MATCH_BUDGET

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
    branch: `refs/heads/feature/workspace-${index}-rebuild`,
    isBare: false,
    isMainWorktree: false,
    displayName: `scan daily 1.4.${index} · 2026-08-13 · ${`${index}`.padStart(7, '9')}`,
    comment: LONG_COMMENT,
    linkedIssue: 1000 + index,
    linkedPR: 2000 + index,
    linkedLinearIssue: `ORC-${index}`,
    linkedWorkItem: {
      provider: 'linear',
      type: 'issue',
      number: index,
      title: `Rework the palette ranking pipeline for workspace ${index}`,
      url: `https://linear.app/acme/issue/ORC-${index}`,
      linearIdentifier: `ORC-${index}`
    },
    automationProvenance: {
      kind: 'created-by-automation',
      automationId: 'auto-1',
      automationNameSnapshot: 'Nightly review',
      automationRunId: `run-${index}`,
      automationRunTitleSnapshot: `Scan daily sweep ${index}`,
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
    `/repos/orca::${worktree.id}`,
    { data: { number: 1000 + index, title: `Cached issue title ${index}` } }
  ])
)

const sources = {
  repoMap,
  issueCache,
  workspacePortsByWorktreeId: ports,
  hostLabelByWorktreeId: new Map(worktrees.map((worktree) => [worktree.id, 'bastion-eu']))
}

const WORST_QUERY = Array.from({ length: tokenCount }, (_, index) =>
  index === 0 ? 'scan' : index === 1 ? 'daily' : `token${index}`
).join(' ')

function prepareWorstQuery(): { tokens: readonly PaletteQueryToken[]; normalized: string } {
  const prepared = preparePaletteQuery(WORST_QUERY)
  if (prepared.state !== 'ready') {
    throw new Error(`Expected a ready query, got ${prepared.state}`)
  }
  return { tokens: prepared.tokens, normalized: prepared.normalized }
}

const preparedQuery = prepareWorstQuery()

function matchEveryDocument(documents: ReadonlyMap<string, PaletteDocument>): void {
  for (const document of documents.values()) {
    matchPaletteDocument({
      document,
      tokens: preparedQuery.tokens,
      normalizedQuery: preparedQuery.normalized
    })
  }
}

/**
 * Why the fastest sample and not p95: this runs in a vitest worker competing for
 * cores with the rest of the suite, so a slow sample records a preemption rather
 * than the matcher. The fastest sample is the least contaminated estimate of
 * intrinsic cost — measured stable within 1.6x on a fully saturated machine,
 * while the slowest of the same batch swung by 17x.
 */
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

describe('palette matcher performance budget', () => {
  it('normalizes a cold corpus within budget', () => {
    const samples = timeRepeatedly(() => buildWorktreePaletteDocuments(worktrees, sources), 5)
    expect(fastestSample(samples)).toBeLessThan(PALETTE_MATCH_BUDGET.coldBuildMs)
  })

  it('matches a 16-token query against warm documents within budget', () => {
    const documents = buildWorktreePaletteDocuments(worktrees, sources)

    // Warm the matcher before timing so JIT compilation is not part of the samples.
    matchEveryDocument(documents)

    const samples = timeRepeatedly(() => matchEveryDocument(documents), 10)
    expect(fastestSample(samples)).toBeLessThan(PALETTE_MATCH_BUDGET.warmMatchMs)
  })

  it('bounds field-match fan-out per candidate', () => {
    const documents = buildWorktreePaletteDocuments(worktrees, sources)
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

  it('keeps the retained document payload within budget', () => {
    const documents = buildWorktreePaletteDocuments(worktrees, sources)
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

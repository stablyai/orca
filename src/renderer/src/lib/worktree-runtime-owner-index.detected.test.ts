import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  findIndexedDetectedWorktrees,
  hasIndexedDetectedWorktree,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'

type OwnerRecord = {
  id: string
  repoId: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}
type DetectedByRepo = Record<string, { worktrees: readonly OwnerRecord[] }>

// The pre-index expressions this module replaced, kept verbatim as parity oracles.
function walkHasDetected(detectedWorktreesByRepo: DetectedByRepo | undefined, id: string): boolean {
  return Object.values(detectedWorktreesByRepo ?? {}).some((result) =>
    result.worktrees.some((worktree) => worktree.id === id)
  )
}

function walkDetectedMatches(
  detectedWorktreesByRepo: DetectedByRepo | undefined,
  id: string
): OwnerRecord[] {
  const matches: OwnerRecord[] = []
  for (const result of Object.values(detectedWorktreesByRepo ?? {})) {
    for (const worktree of result.worktrees) {
      if (worktree.id === id) {
        matches.push(worktree)
      }
    }
  }
  return matches
}

function walkHasKnown(
  worktreesByRepo: Record<string, readonly OwnerRecord[]> | undefined,
  id: string
): boolean {
  return Object.values(worktreesByRepo ?? {}).some((worktrees) =>
    worktrees.some((worktree) => worktree.id === id)
  )
}

// Deterministic LCG so a parity failure reproduces from the printed case index.
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const HOST_IDS: (ExecutionHostId | undefined)[] = [
  undefined,
  'local',
  'ssh:target-a',
  'ssh:target-b',
  'runtime:hub-a'
]

function buildCase(random: () => number): {
  detectedWorktreesByRepo: DetectedByRepo | undefined
  worktreesByRepo: Record<string, readonly OwnerRecord[]>
  probeIds: string[]
} {
  const shape = random()
  if (shape < 0.05) {
    return { detectedWorktreesByRepo: undefined, worktreesByRepo: {}, probeIds: ['repo-0::absent'] }
  }
  if (shape < 0.1) {
    return { detectedWorktreesByRepo: {}, worktreesByRepo: {}, probeIds: ['repo-0::absent'] }
  }
  const repoCount = 1 + Math.floor(random() * 6)
  const detectedWorktreesByRepo: DetectedByRepo = {}
  const worktreesByRepo: Record<string, readonly OwnerRecord[]> = {}
  const knownIds: string[] = []
  for (let repoIndex = 0; repoIndex < repoCount; repoIndex += 1) {
    const repoId = `repo-${repoIndex}`
    // Empty arrays are a real store shape: a scan that found nothing still publishes its bucket.
    const worktreeCount = random() < 0.25 ? 0 : 1 + Math.floor(random() * 5)
    const detected: OwnerRecord[] = []
    const published: OwnerRecord[] = []
    for (let index = 0; index < worktreeCount; index += 1) {
      // Duplicate ids across repos are how rival publications collide, so allow a shared pool.
      const id = random() < 0.3 ? `shared::worktree-${index}` : `${repoId}::worktree-${index}`
      const record: OwnerRecord = {
        id,
        repoId,
        hostId: HOST_IDS[Math.floor(random() * HOST_IDS.length)],
        ...(random() < 0.3 ? { runtimeOwnerEnvironmentId: `hub-${Math.floor(random() * 3)}` } : {})
      }
      knownIds.push(id)
      if (random() < 0.8) {
        detected.push(record)
      }
      if (random() < 0.5) {
        published.push(record)
      }
    }
    detectedWorktreesByRepo[repoId] = { worktrees: detected }
    worktreesByRepo[repoId] = published
  }
  const probeIds = [
    knownIds[0] ?? 'repo-0::absent',
    knownIds.at(-1) ?? 'repo-0::absent',
    knownIds[Math.floor(random() * Math.max(knownIds.length, 1))] ?? 'repo-0::absent',
    'shared::worktree-0',
    'never-published::worktree'
  ]
  return { detectedWorktreesByRepo, worktreesByRepo, probeIds }
}

describe('detected worktree index', () => {
  it('matches the pre-index catalog walk across randomized store shapes', () => {
    const random = makeRandom(0x5eed)
    for (let caseIndex = 0; caseIndex < 240; caseIndex += 1) {
      const { detectedWorktreesByRepo, worktreesByRepo, probeIds } = buildCase(random)
      for (const probeId of probeIds) {
        expect(
          {
            case: caseIndex,
            probeId,
            has: hasIndexedDetectedWorktree(detectedWorktreesByRepo, probeId)
          },
          `case ${caseIndex} / ${probeId}`
        ).toEqual({
          case: caseIndex,
          probeId,
          has: walkHasDetected(detectedWorktreesByRepo, probeId)
        })
        expect(
          findIndexedDetectedWorktrees(detectedWorktreesByRepo, probeId),
          `case ${caseIndex} / ${probeId}`
        ).toEqual(walkDetectedMatches(detectedWorktreesByRepo, probeId))
        expect(
          resolveIndexedWorktreeOwner(worktreesByRepo, probeId).kind !== 'missing',
          `case ${caseIndex} / ${probeId}`
        ).toBe(walkHasKnown(worktreesByRepo, probeId))
      }
    }
  })

  it('returns rival publications in catalog order with identity preserved', () => {
    const first = { id: 'shared', repoId: 'repo-a', hostId: 'ssh:target-a' as const }
    const second = { id: 'shared', repoId: 'repo-b', hostId: 'runtime:hub-a' as const }
    const detectedWorktreesByRepo = {
      'repo-a': { worktrees: [first] },
      'repo-b': { worktrees: [second] }
    }

    const matches = findIndexedDetectedWorktrees(detectedWorktreesByRepo, 'shared')
    expect(matches).toHaveLength(2)
    expect(matches[0]).toBe(first)
    expect(matches[1]).toBe(second)
  })

  it('treats undefined, empty, and empty-bucket catalogs as unpublished', () => {
    expect(hasIndexedDetectedWorktree(undefined, 'repo::wt')).toBe(false)
    expect(findIndexedDetectedWorktrees(undefined, 'repo::wt')).toEqual([])
    expect(hasIndexedDetectedWorktree({}, 'repo::wt')).toBe(false)
    expect(hasIndexedDetectedWorktree({ repo: { worktrees: [] } }, 'repo::wt')).toBe(false)
  })

  it('re-indexes a new catalog identity instead of serving stale hits', () => {
    const worktree = { id: 'repo::wt', repoId: 'repo' }
    const before = { repo: { worktrees: [worktree] } }
    expect(hasIndexedDetectedWorktree(before, 'repo::wt')).toBe(true)

    const afterRemoval = { repo: { worktrees: [] } }
    expect(hasIndexedDetectedWorktree(afterRemoval, 'repo::wt')).toBe(false)

    const afterReadd = { repo: { worktrees: [worktree] } }
    expect(findIndexedDetectedWorktrees(afterReadd, 'repo::wt')).toEqual([worktree])
    // The prior identity keeps its own cached answer; nothing bleeds between snapshots.
    expect(hasIndexedDetectedWorktree(afterRemoval, 'repo::wt')).toBe(false)
    expect(hasIndexedDetectedWorktree(before, 'repo::wt')).toBe(true)
  })
})

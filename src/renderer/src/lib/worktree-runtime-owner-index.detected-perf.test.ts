import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { hasIndexedDetectedWorktree } from './worktree-runtime-owner-index'
import { getExplicitRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

const REPO_COUNT = 20
const WORKTREES_PER_REPO = 100
const LOOKUPS_PER_SWEEP = 200
const SWEEPS = 40

type OwnerRecord = {
  id: string
  repoId: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}
type DetectedByRepo = Record<string, { worktrees: readonly OwnerRecord[] }>

// The pre-index expression, kept as the "before" leg of the benchmark.
function walkHasDetected(detectedWorktreesByRepo: DetectedByRepo | undefined, id: string): boolean {
  return Object.values(detectedWorktreesByRepo ?? {}).some((result) =>
    result.worktrees.some((worktree) => worktree.id === id)
  )
}

function buildDetectedCatalog(generation: number, counter?: { reads: number }): DetectedByRepo {
  const catalog: DetectedByRepo = {}
  for (let repoIndex = 0; repoIndex < REPO_COUNT; repoIndex += 1) {
    const repoId = `repo-${repoIndex}`
    const worktrees: OwnerRecord[] = []
    for (let index = 0; index < WORKTREES_PER_REPO; index += 1) {
      const id = `${repoId}::detected-${index}-gen-${generation}`
      const record: OwnerRecord = { id, repoId, hostId: 'ssh:target-a' }
      if (counter) {
        Object.defineProperty(record, 'id', {
          get: () => {
            counter.reads += 1
            return id
          },
          enumerable: true
        })
      }
      worktrees.push(record)
    }
    catalog[repoId] = { worktrees }
  }
  return catalog
}

const publishedRepos = Array.from({ length: REPO_COUNT }, (_unused, index) => ({
  id: `repo-${index}`,
  connectionId: `target-${index}`
}))
const publishedWorktreesByRepo: Record<string, OwnerRecord[]> = Object.fromEntries(
  publishedRepos.map((repo) => [
    repo.id,
    Array.from({ length: WORKTREES_PER_REPO }, (_unused, index) => ({
      id: `${repo.id}::worktree-${index}`,
      repoId: repo.id,
      hostId: 'ssh:target-a' as const
    }))
  ])
)

// Only the detected catalog changes identity: that is what isolates the collection under test.
function buildOwnerState(detectedWorktreesByRepo: DetectedByRepo): WorktreeRuntimeOwnerState {
  return {
    repos: publishedRepos,
    worktreesByRepo: publishedWorktreesByRepo,
    detectedWorktreesByRepo,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    runtimeEnvironments: []
  }
}

// Probe ids are published but never detected — the SSH-pane case, and the walk's worst case.
const PROBE_IDS = Array.from(
  { length: LOOKUPS_PER_SWEEP },
  (_unused, index) => `repo-${index % REPO_COUNT}::worktree-${index % WORKTREES_PER_REPO}`
)

const WARMUP_SWEEPS = 5
const warmCatalog = buildDetectedCatalog(-1)

// Each fresh leg needs its own never-indexed catalogs; a shared pool would leave the index warm
// for whichever leg runs second and silently erase the rebuild it is supposed to measure.
let catalogGeneration = 0
function freshCatalogPool(): DetectedByRepo[] {
  return Array.from({ length: SWEEPS + WARMUP_SWEEPS }, () =>
    buildDetectedCatalog((catalogGeneration += 1))
  )
}

function measureSweeps(run: (sweep: number) => void): number {
  for (let warmup = 0; warmup < WARMUP_SWEEPS; warmup += 1) {
    run(warmup)
  }
  const started = performance.now()
  for (let sweep = 0; sweep < SWEEPS; sweep += 1) {
    run(WARMUP_SWEEPS + sweep)
  }
  return (performance.now() - started) / SWEEPS
}

describe('detected worktree index performance', () => {
  it('answers repeated owner lookups without rescanning the detected catalog', () => {
    const counter = { reads: 0 }
    const catalog = buildDetectedCatalog(0, counter)
    const state = buildOwnerState(catalog)

    getExplicitRuntimeEnvironmentIdForWorktree(state, 'repo-0::warm-the-index')
    counter.reads = 0
    for (const probeId of PROBE_IDS) {
      getExplicitRuntimeEnvironmentIdForWorktree(state, probeId)
    }
    const indexedReads = counter.reads

    counter.reads = 0
    for (const probeId of PROBE_IDS) {
      walkHasDetected(catalog, probeId)
    }
    const walkedReads = counter.reads

    expect(indexedReads).toBe(0)
    expect(walkedReads).toBeGreaterThan(100_000)
  })

  it('records lookup-path timing without making wall clock a CI gate', () => {
    const walkPool = freshCatalogPool()
    const walkMs = measureSweeps((sweep) => {
      const catalog = walkPool[sweep]!
      for (const probeId of PROBE_IDS) {
        walkHasDetected(catalog, probeId)
      }
    })
    const walkWarmMs = measureSweeps(() => {
      for (const probeId of PROBE_IDS) {
        walkHasDetected(warmCatalog, probeId)
      }
    })
    // Unrelated store writes leave the detected catalog identical, so the index stays warm.
    const warmMs = measureSweeps(() => {
      for (const probeId of PROBE_IDS) {
        hasIndexedDetectedWorktree(warmCatalog, probeId)
      }
    })
    // A landed worktree scan republishes the catalog: one rebuild amortized over the sweep.
    const freshPool = freshCatalogPool()
    const freshMs = measureSweeps((sweep) => {
      const catalog = freshPool[sweep]!
      for (const probeId of PROBE_IDS) {
        hasIndexedDetectedWorktree(catalog, probeId)
      }
    })

    const statePool = freshCatalogPool().map(buildOwnerState)
    const warmState = buildOwnerState(warmCatalog)
    const explicitOwnerFreshMs = measureSweeps((sweep) => {
      const state = statePool[sweep]!
      for (const probeId of PROBE_IDS) {
        getExplicitRuntimeEnvironmentIdForWorktree(state, probeId)
      }
    })
    const explicitOwnerWarmMs = measureSweeps(() => {
      for (const probeId of PROBE_IDS) {
        getExplicitRuntimeEnvironmentIdForWorktree(warmState, probeId)
      }
    })

    const round = (value: number): number => Number(value.toFixed(4))
    const report = {
      entries: REPO_COUNT * WORKTREES_PER_REPO,
      lookupsPerSweep: LOOKUPS_PER_SWEEP,
      sweeps: SWEEPS,
      lookupPath: {
        walkFreshMsPerSweep: round(walkMs),
        walkWarmMsPerSweep: round(walkWarmMs),
        indexedWarmMsPerSweep: round(warmMs),
        indexedFreshMsPerSweep: round(freshMs),
        warmSpeedup: round(walkWarmMs / warmMs),
        freshSpeedup: round(walkMs / freshMs)
      },
      getExplicitRuntimeEnvironmentIdForWorktree: {
        warmMsPerSweep: round(explicitOwnerWarmMs),
        freshMsPerSweep: round(explicitOwnerFreshMs)
      }
    }
    writeFileSync(
      join(tmpdir(), 'orca-detected-worktree-index-bench.json'),
      `${JSON.stringify(report, null, 2)}\n`
    )

    // Why: shared-runner timing is noisy; the read-count test above is the deterministic CI gate.
  })
})

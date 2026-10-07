import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getExplicitRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

const REPO_COUNT = 20
const WORKTREES_PER_REPO = 100
const LOOKUPS_PER_SWEEP = 200

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
})

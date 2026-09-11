import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { advanceRuntimeEnvironmentConnectionGeneration } from './runtime-status-connection-generation'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from './worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

const ENV = 'env-remote'
const REPO_IDS = ['repo1', 'repo2', 'repo3', 'repo4', 'repo5'] as const

function seedRuntimeRepos(store: ReturnType<typeof createTestStore>) {
  store.setState({
    repos: REPO_IDS.map((id) => ({
      id,
      path: `C:/remote/${id}`,
      executionHostId: `runtime:${ENV}`
    })),
    settings: { activeRuntimeEnvironmentId: ENV },
    hasHydratedWorktreePurge: true
  } as unknown as Partial<AppState>)
}

function detectedFor(repoId: string) {
  return makeDetectedResult(repoId, [
    makeWorktree({
      id: `${repoId}::/remote/${repoId}/wt`,
      repoId,
      path: `/remote/${repoId}/wt`,
      branch: 'refs/heads/main'
    })
  ])
}

function repoOf(args: RuntimeEnvironmentCallRequest): string {
  return (args.params as { repo: string }).repo
}

function detectedListReply(repoId: string) {
  return {
    id: 'rpc',
    ok: true,
    result: detectedFor(repoId),
    _meta: { runtimeId: 'runtime-remote' }
  }
}

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  vi.clearAllMocks()
  resetRemoteRuntimeMocks()
})

describe('fetchAllWorktrees across a runtime connection-generation change', () => {
  it('publishes every repo when nothing perturbs the connection', async () => {
    const store = createTestStore()
    seedRuntimeRepos(store)
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      detectedListReply(repoOf(args))
    )

    await store.getState().fetchAllWorktrees()

    expect(Object.keys(store.getState().worktreesByRepo).sort()).toEqual([...REPO_IDS])
  })

  it('re-reads instead of dropping the repos still in flight when the generation moves', async () => {
    // Regression (#19241): scans run concurrently across a host's repos, so one generation
    // bump discarded every repo still outstanding. Their rows then never reached the
    // sidebar — a strict subset of the host's worktrees, stable until an unrelated refresh.
    const store = createTestStore()
    seedRuntimeRepos(store)
    const parked = new Map<string, () => void>()
    let bumped = false
    runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
      const repo = repoOf(args)
      // Park every repo but the first, so the bump lands with four scans outstanding.
      if (repo !== 'repo1' && !bumped) {
        await new Promise<void>((resolve) => parked.set(repo, resolve))
      }
      return detectedListReply(repo)
    })

    const fetching = store.getState().fetchAllWorktrees()
    await vi.waitFor(() => expect(parked.size).toBe(REPO_IDS.length - 1))
    bumped = true
    advanceRuntimeEnvironmentConnectionGeneration(ENV)
    for (const release of parked.values()) {
      release()
    }
    await fetching

    expect(Object.keys(store.getState().worktreesByRepo).sort()).toEqual([...REPO_IDS])
    for (const repoId of REPO_IDS) {
      expect(store.getState().worktreesByRepo[repoId]).toHaveLength(1)
    }
  })

  it('gives up after one re-read so a churning connection cannot stall the caller', async () => {
    const store = createTestStore()
    seedRuntimeRepos(store)
    const attemptsByRepo = new Map<string, number>()
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      const repo = repoOf(args)
      attemptsByRepo.set(repo, (attemptsByRepo.get(repo) ?? 0) + 1)
      // Bump on every answer: the retried read is stale again the moment it lands.
      advanceRuntimeEnvironmentConnectionGeneration(ENV)
      return detectedListReply(repo)
    })

    await store.getState().fetchAllWorktrees()

    expect(Object.keys(store.getState().worktreesByRepo)).toEqual([])
    for (const repoId of REPO_IDS) {
      expect(attemptsByRepo.get(repoId)).toBe(2)
    }
  })
})

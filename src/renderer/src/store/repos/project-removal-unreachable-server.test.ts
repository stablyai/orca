// Removing a paired-server project while that server is unreachable (STA-9705).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  listPendingRuntimeRepoRemovals,
  resetPendingRuntimeRepoRemovalsForTests,
  seedPendingRuntimeRepoRemovals
} from './pending-runtime-repo-removals'
import {
  observeRuntimeHostStatusForPendingRemovals,
  resetPendingRuntimeRepoRemovalReplayForTests
} from './pending-runtime-repo-removal-replay'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

const remoteRepo: Repo = {
  id: 'app',
  path: '/home/me/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 1,
  executionHostId: 'runtime:env-1'
}

const UNREACHABLE =
  'Could not connect to the remote Orca runtime at ws://192.0.2.1:6768: the host did not answer'
let reachable = false
const hostCalls: string[] = []
let answerRepoRm: () => Promise<unknown> = async () => ({ removed: true })
const uiSet = vi.fn().mockResolvedValue(undefined)

async function answer(args: RuntimeEnvironmentCallRequest): Promise<unknown> {
  if (!reachable) {
    throw new Error(UNREACHABLE)
  }
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  hostCalls.push(args.method)
  const meta = { runtimeId: 'runtime-remote' }
  if (args.method === 'repo.rm') {
    return { id: 'repo.rm', ok: true, result: await answerRepoRm(), _meta: meta }
  }
  if (args.method === 'repo.add') {
    return { id: 'repo.add', ok: true, result: { repo: remoteRepo }, _meta: meta }
  }
  return { id: args.method, ok: true, result: {}, _meta: meta }
}

function readySnapshot(): RuntimeHostStatusSnapshot {
  return {
    environmentId: 'env-1',
    pairingRevision: 1,
    sequence: 1,
    checkedAt: 1,
    status: null,
    verification: 'verified',
    transport: 'ready'
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  resetPendingRuntimeRepoRemovalsForTests()
  resetPendingRuntimeRepoRemovalReplayForTests()
  vi.mocked(toast.error).mockReset()
  uiSet.mockClear()
  hostCalls.length = 0
  reachable = false
  answerRepoRm = async () => ({ removed: true })
  vi.stubGlobal('window', {
    api: {
      repos: { remove: vi.fn(), removeForHost: vi.fn() },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: vi.fn(answer), list: vi.fn(async () => [{ id: 'env-1' }]) },
      ui: { set: uiSet }
    }
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('removing a project while its paired server is unreachable', () => {
  it('retries when the server reconnects while a replay is still failing', async () => {
    seedPendingRuntimeRepoRemovals([{ environmentId: 'env-1', repoId: 'app', requestedAt: 1 }])
    reachable = true
    let failFirstRm: () => void = () => {}
    let rmAttempts = 0
    answerRepoRm = () => {
      rmAttempts += 1
      return rmAttempts === 1
        ? new Promise((_resolve, reject) => {
            failFirstRm = () => reject(new Error(UNREACHABLE))
          })
        : Promise.resolve({ removed: true })
    }

    observeRuntimeHostStatusForPendingRemovals(readySnapshot())
    await vi.waitFor(() => expect(rmAttempts).toBe(1), { timeout: 20_000 })
    observeRuntimeHostStatusForPendingRemovals({ ...readySnapshot(), transport: 'disconnected' })
    observeRuntimeHostStatusForPendingRemovals(readySnapshot())
    failFirstRm()

    await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([]), {
      timeout: 20_000
    })
    expect(rmAttempts).toBe(2)
  })

  it('holds a re-add until an in-flight replay has finished', async () => {
    seedPendingRuntimeRepoRemovals([{ environmentId: 'env-1', repoId: 'app', requestedAt: 1 }])
    reachable = true
    let finishRm: () => void = () => {}
    answerRepoRm = () =>
      new Promise((resolve) => {
        finishRm = () => resolve({ removed: true })
      })
    const store = createTestStore()

    observeRuntimeHostStatusForPendingRemovals(readySnapshot())
    await vi.waitFor(() => expect(hostCalls).toContain('repo.rm'), { timeout: 20_000 })
    const added = store.getState().addRepoPath('/home/me/app', 'git', {
      runtimeEnvironmentId: 'env-1'
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(hostCalls).not.toContain('repo.add')

    finishRm()
    await added
    expect(hostCalls.filter((m) => m === 'repo.rm' || m === 'repo.add')).toEqual([
      'repo.rm',
      'repo.add'
    ])
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['app'])
  })
})

import { countOpenRepoTerminalTabs } from '../repos/repo-removal'
import type { RuntimeHostStatusSnapshot } from '../../../../shared/runtime-host-status'

import type { Repo } from '../../../../shared/repo-types'
// Removing a paired-server project while that server is unreachable (STA-9705).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore, makeWorktree } from './store-test-helpers'

import {
  type RuntimeEnvironmentCallRequest,
  createCompatibleRuntimeStatusResponseIfNeeded
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { mergeFetchedRepoCatalog } from '../repos/repo-catalog-merge'
import {
  listPendingRuntimeRepoRemovals,
  recordPendingRuntimeRepoRemoval,
  withoutPendingRuntimeRepoRemovals,
  replayPendingRuntimeRepoRemovals,
  resetPendingRuntimeRepoRemovalsForTests,
  seedPendingRuntimeRepoRemovals
} from '../repos/pending-runtime-repo-removals'
import {
  observeRuntimeHostStatusForPendingRemovals,
  replayPendingRuntimeRepoRemovalsForReadyServers,
  resetPendingRuntimeRepoRemovalReplayForTests
} from '../repos/pending-runtime-repo-removal-replay'

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
let answerRepoRm: (repo?: unknown) => Promise<unknown> = async () => ({ removed: true })
let answerRepoAdd: () => Promise<Repo> = async () => remoteRepo
const rmInputs: unknown[] = []
const uiSet = vi.fn<typeof window.api.ui.set>().mockResolvedValue(undefined)

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
    rmInputs.push(args.params?.repo)
    return { id: 'repo.rm', ok: true, result: await answerRepoRm(args.params?.repo), _meta: meta }
  }
  if (args.method === 'repo.add') {
    return { id: 'repo.add', ok: true, result: { repo: await answerRepoAdd() }, _meta: meta }
  }
  return { id: args.method, ok: true, result: {}, _meta: meta }
}

function seedRemoteProject(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const worktree = makeWorktree({ id: 'app::/home/me/app', repoId: 'app', hostId: 'runtime:env-1' })
  store.setState({ repos: [remoteRepo], worktreesByRepo: { app: [worktree] } })
  return store
}

function serverStillLists(store: ReturnType<typeof createTestStore>): readonly Repo[] {
  return mergeFetchedRepoCatalog(
    {
      repos: [remoteRepo],
      projectHostSetupCompatibility: { projects: [], setups: [] },
      hostId: 'runtime:env-1',
      reposAtRequest: store.getState().repos
    },
    store.getState().repos
  ).repos
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
  rmInputs.length = 0
  answerRepoAdd = async () => remoteRepo
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
  it('offers local removal, fences the server catalog, and replays repo.rm on reconnect', async () => {
    const store = seedRemoteProject()

    await store.getState().removeProject('app', { hostId: 'runtime:env-1', errorFeedback: 'toast' })

    expect(store.getState().repos).toEqual([remoteRepo])
    expect(vi.mocked(toast.error).mock.calls[0]?.[1]?.action).toMatchObject({
      label: 'Remove from this desktop now'
    })

    // What that action runs: the same removal, skipping the unreachable server.
    await store.getState().removeProject('app', { hostId: 'runtime:env-1', localOnly: true })
    expect(store.getState().repos).toEqual([])
    expect(listPendingRuntimeRepoRemovals('env-1')).toMatchObject([{ repoId: 'app' }])
    expect(uiSet).toHaveBeenLastCalledWith({
      pendingRuntimeRepoRemovals: [
        expect.objectContaining({ environmentId: 'env-1', repoId: 'app' })
      ]
    })
    // The server still lists it until the replay lands; that listing must not re-add it.
    expect(serverStillLists(store)).toEqual([])

    reachable = true
    observeRuntimeHostStatusForPendingRemovals(readySnapshot())
    await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([]), {
      timeout: 20_000
    })
    expect(hostCalls.filter((method) => method === 'repo.rm')).toEqual(['repo.rm'])
    expect(uiSet).toHaveBeenLastCalledWith({ pendingRuntimeRepoRemovals: [] })
  })

  it('replays records seeded after the server already reported ready', async () => {
    reachable = true
    observeRuntimeHostStatusForPendingRemovals(readySnapshot())

    seedPendingRuntimeRepoRemovals([{ environmentId: 'env-1', repoId: 'app', requestedAt: 1 }])
    replayPendingRuntimeRepoRemovalsForReadyServers()

    await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([]), {
      timeout: 20_000
    })
    expect(hostCalls.filter((method) => method === 'repo.rm')).toEqual(['repo.rm'])
  })

  it('keeps a record across disconnect, reconnect and re-pair, then replays it', async () => {
    seedPendingRuntimeRepoRemovals([{ environmentId: 'env-1', repoId: 'app', requestedAt: 1 }])
    const disconnected = { ...readySnapshot(), transport: 'disconnected' as const }

    // Disconnect retires the status owner; a re-pair retires it again under a new revision.
    observeRuntimeHostStatusForPendingRemovals(disconnected)
    observeRuntimeHostStatusForPendingRemovals({ ...disconnected, retired: true })
    observeRuntimeHostStatusForPendingRemovals({
      ...disconnected,
      pairingRevision: 2,
      retired: true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listPendingRuntimeRepoRemovals('env-1')).toHaveLength(1)

    reachable = true
    observeRuntimeHostStatusForPendingRemovals({ ...readySnapshot(), pairingRevision: 2 })
    await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([]), {
      timeout: 20_000
    })
    expect(hostCalls.filter((method) => method === 'repo.rm')).toEqual(['repo.rm'])
  })

  it('drops records only once the server is forgotten', async () => {
    seedPendingRuntimeRepoRemovals([{ environmentId: 'env-1', repoId: 'app', requestedAt: 1 }])

    vi.mocked(window.api.runtimeEnvironments.list).mockResolvedValue([])
    observeRuntimeHostStatusForPendingRemovals({ ...readySnapshot(), retired: true })
    await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([]))
  })

  it('replays at once when local removal is chosen while the server already reports ready', async () => {
    const store = seedRemoteProject()
    observeRuntimeHostStatusForPendingRemovals(readySnapshot())
    reachable = true

    await store.getState().removeProject('app', { hostId: 'runtime:env-1', localOnly: true })

    await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([]), {
      timeout: 20_000
    })
    expect(hostCalls.filter((method) => method === 'repo.rm')).toEqual(['repo.rm'])
    expect(store.getState().repos).toEqual([])
  })

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

  it('never lets a replayed repo.rm undo a re-add of the same project', async () => {
    seedPendingRuntimeRepoRemovals([{ environmentId: 'env-1', repoId: 'app', requestedAt: 1 }])
    reachable = true
    const store = createTestStore()

    // Re-add first: it clears the record, so the replay that reconnect starts removes nothing.
    const added = store.getState().addRepoPath('/home/me/app', 'git', {
      runtimeEnvironmentId: 'env-1'
    })
    const replay = replayPendingRuntimeRepoRemovals(
      'env-1',
      async (repoId) => {
        hostCalls.push(`replay:${repoId}`)
      },
      vi.fn()
    )
    await Promise.all([added, replay])

    expect(hostCalls).not.toContain('replay:app')
    expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([])
    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['app'])
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

it('settles records added during a real ready replay through the existing follow-up without duplicate dispatch', async () => {
  seedPendingRuntimeRepoRemovals([{ environmentId: 'env-1', repoId: 'app', requestedAt: 1 }])
  reachable = true
  let release!: () => void
  answerRepoRm = (raw) =>
    raw === 'app'
      ? new Promise((resolve) => {
          release = () => resolve({ removed: true })
        })
      : Promise.resolve({ removed: true })
  observeRuntimeHostStatusForPendingRemovals(readySnapshot())
  await vi.waitFor(() => expect(rmInputs).toEqual(['app']))
  recordPendingRuntimeRepoRemoval('env-1', 'late')
  expect(
    withoutPendingRuntimeRepoRemovals([{ ...remoteRepo, id: 'late' }], 'runtime:env-1')
  ).toEqual([])
  release()
  await vi.waitFor(() => expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([]))
  expect(rmInputs).toEqual(['app', 'late'])
  expect(uiSet).toHaveBeenLastCalledWith({ pendingRuntimeRepoRemovals: [] })
})

it.each(['failure', 'different-id', 'same-id'] as const)(
  'keeps existing re-add address cancellation at actual %s settlement',
  async (outcome) => {
    seedPendingRuntimeRepoRemovals([
      { environmentId: 'env-1', repoId: 'app', requestedAt: 1 },
      { environmentId: 'env-1', repoId: 'q', requestedAt: 2 },
      { environmentId: 'other', repoId: 'app', requestedAt: 3 }
    ])
    reachable = true
    answerRepoAdd = async () => {
      if (outcome === 'failure') {
        throw new Error('actual add failed')
      }
      return outcome === 'different-id' ? { ...remoteRepo, id: 'different' } : remoteRepo
    }
    const store = createTestStore()
    const added = await store
      .getState()
      .addRepoPath('/home/me/app', 'git', { runtimeEnvironmentId: 'env-1' })
    expect(Boolean(added)).toBe(outcome !== 'failure')
    expect(listPendingRuntimeRepoRemovals('env-1').map((entry) => entry.repoId)).toEqual(
      outcome === 'same-id' ? ['q'] : ['app', 'q']
    )
    expect(listPendingRuntimeRepoRemovals('other').map((entry) => entry.repoId)).toEqual(['app'])
    expect(rmInputs).toEqual([])
  }
)

it.each([100, 1000])(
  'charges the real pending P=%s owner list/reread/clear/persist work separately from q sends',
  async (p) => {
    for (const q of [1, 2, p]) {
      let environmentReads = 0
      let rawReads = 0
      let saves = 0
      let serializedBytes = 0
      seedPendingRuntimeRepoRemovals(
        Array.from({ length: p }, (_, i) => ({
          environmentId: i < q ? 'env-1' : 'other',
          repoId: `pending-${i}`,
          requestedAt: i
        }))
      )
      for (const entry of [
        ...listPendingRuntimeRepoRemovals('env-1'),
        ...listPendingRuntimeRepoRemovals('other')
      ]) {
        const environmentId = entry.environmentId
        const repoId = entry.repoId
        Object.defineProperty(entry, 'environmentId', {
          enumerable: true,
          get() {
            environmentReads++
            return environmentId
          }
        })
        Object.defineProperty(entry, 'repoId', {
          enumerable: true,
          get() {
            rawReads++
            return repoId
          }
        })
      }
      uiSet.mockImplementation(async (patch) => {
        saves++
        serializedBytes += JSON.stringify(patch).length
      })
      const payloads: string[] = []
      let outstanding = 0
      let maxOutstanding = 0
      const outcome = await replayPendingRuntimeRepoRemovals(
        'env-1',
        async (raw) => {
          outstanding++
          maxOutstanding = Math.max(maxOutstanding, outstanding)
          payloads.push(raw)
          await Promise.resolve()
          outstanding--
          return { removed: true }
        },
        () => {
          throw new Error('successful fixture must not refuse')
        }
      )
      await Promise.resolve()
      const measured = { environmentReads, rawReads, saves, serializedBytes }
      expect(outcome).toBe('settled')
      expect(payloads).toEqual(Array.from({ length: q }, (_, i) => `pending-${i}`))
      expect(listPendingRuntimeRepoRemovals('env-1')).toEqual([])
      expect(listPendingRuntimeRepoRemovals('other')).toHaveLength(p - q)
      expect(maxOutstanding).toBe(1)
      expect(measured.environmentReads).toBeGreaterThanOrEqual(p)
      expect(measured.saves).toBe(q)
      process.stdout.write(
        `R pending owner work ${JSON.stringify({ p, q, ...measured, sends: payloads.length, maxOutstanding })}\n`
      )
    }
  }
)

describe('countOpenRepoTerminalTabs', () => {
  it('counts tabs with a PTY on the removed host only', () => {
    const state = {
      worktreesByRepo: {
        'repo-1': [
          { id: 'repo-1::/a', hostId: 'local' },
          { id: 'repo-1::/srv/a', hostId: 'ssh:box' }
        ]
      },
      detectedWorktreesByRepo: {},
      tabsByWorktree: {
        'repo-1::/a': [{ id: 'tab-live' }, { id: 'tab-no-pty' }],
        'repo-1::/srv/a': [{ id: 'tab-ssh' }]
      },
      ptyIdsByTabId: { 'tab-live': ['pty-1'], 'tab-no-pty': [], 'tab-ssh': ['pty-2'] }
    }

    expect(countOpenRepoTerminalTabs(state, 'repo-1', 'local')).toBe(1)
    expect(countOpenRepoTerminalTabs(state, 'repo-1', 'ssh:box')).toBe(1)
    expect(countOpenRepoTerminalTabs(state, 'repo-2', 'local')).toBe(0)
  })
})

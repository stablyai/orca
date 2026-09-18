import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { EphemeralVmRuntimeRecord } from '../../../shared/ephemeral-vm-runtimes'
import { createTestStore } from '../store/slices/store-test-helpers'
import { clearRuntimeCompatibilityCacheForTests } from '../runtime/runtime-rpc-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../runtime/runtime-compatibility-test-fixture'

const context = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => context.store!.getState() } }))
vi.mock('@/components/status-bar/runtime-environment-explicit-connect', () => ({
  connectRuntimeEnvironmentAndRecordStatus: vi.fn().mockResolvedValue(true)
}))
import { reconnectEphemeralVmWorkspace } from './ephemeral-vm-workspace-resume'

const remoteRepo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#000',
  addedAt: 1
}
const reply = (repos: (typeof remoteRepo)[]) => ({
  id: 'repo-response',
  ok: true,
  result: { repos },
  _meta: { runtimeId: 'runtime-remote' }
})

describe('Cloud VM reconnect with a concurrent catalog refresh', () => {
  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })
  it.each(['same-host', 'all-host'])(
    'retries a discarded fetch superseded by %s without accepting stale rows',
    async (source) => {
      let started!: () => void
      let resolveOlder!: (value: unknown) => void
      const olderStarted = new Promise<void>((resolve) => {
        started = resolve
      })
      const older = new Promise((resolve) => {
        resolveOlder = resolve
      })
      let calls = 0
      vi.stubGlobal('window', {
        api: {
          repos: { list: vi.fn().mockResolvedValue([]) },
          runtimeEnvironments: {
            list: vi.fn().mockResolvedValue([{ id: 'env-1', name: 'Remote' }]),
            call: (args: RuntimeEnvironmentCallRequest) => {
              const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
              if (compatible) {
                return compatible
              }
              if (args.method === 'repo.list') {
                calls++
                if (calls === 1) {
                  started()
                  return older
                }
                return reply([remoteRepo])
              }
              return {
                id: 'other',
                ok: true,
                result: { projects: [], setups: [] },
                _meta: { runtimeId: 'runtime-remote' }
              }
            }
          }
        },
        dispatchEvent: vi.fn()
      })
      const store = createTestStore()
      context.store = store
      const fetchWorktrees = vi.fn().mockResolvedValue([])
      store.setState({ fetchWorktrees, fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined) })
      const runtime: EphemeralVmRuntimeRecord = {
        id: 'runtime-1',
        recipeId: 'vercel-sandbox',
        runtimeEnvironmentId: 'env-1',
        status: 'running',
        cleanupStatus: 'not_started',
        createdAt: 1,
        updatedAt: 1,
        recipeResult: { schemaVersion: 1, pairingCode: 'fixture-pairing', projectRoot: '/remote' }
      }
      const reconnect = reconnectEphemeralVmWorkspace(runtime)
      const completed = expect(reconnect).resolves.toBeUndefined()
      await olderStarted
      await (source === 'same-host'
        ? store.getState().fetchRuntimeEnvironmentRepos('env-1')
        : store.getState().fetchReposForAllHosts())
      resolveOlder(reply([{ ...remoteRepo, id: 'stale-repo' }]))
      await completed
      expect(calls).toBe(3)
      expect(fetchWorktrees).toHaveBeenCalledWith('remote-repo', {
        executionHostId: 'runtime:env-1',
        suppressRemoteLineageRefresh: true
      })
      expect(store.getState().repos.some((repo) => repo.id === 'stale-repo')).toBe(false)
    }
  )
})

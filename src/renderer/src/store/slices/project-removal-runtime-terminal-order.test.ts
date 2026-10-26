// Stop runtime project terminals before repo.rm deletes workspace selectors; stopping afterward leaves remote shells running.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore, makeWorktree } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

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

const localRepo: Repo = {
  id: 'app',
  path: '/Users/me/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 1
}

const hostCalls: string[] = []
let hostKnowsProject = true
let hostSelectorAmbiguous = false
let liveHostTerminals = 0
const removeForHost = vi.fn()

// Mirrors the host contract: once repo.rm drops the project, its workspace selectors stop resolving.
function answerLikeRuntimeHost(args: RuntimeEnvironmentCallRequest): unknown {
  const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
  if (compatible) {
    return compatible
  }
  hostCalls.push(args.method)
  const meta = { runtimeId: 'runtime-remote' }
  if (hostSelectorAmbiguous && (args.method === 'repo.show' || args.method === 'repo.rm')) {
    const error = { code: 'selector_ambiguous', message: 'selector_ambiguous' }
    return { id: args.method, ok: false, error, _meta: meta }
  }
  if (args.method === 'repo.rm') {
    hostKnowsProject = false
    return { id: 'repo.rm', ok: true, result: { removed: true }, _meta: meta }
  }
  if (args.method === 'terminal.stop') {
    if (!hostKnowsProject) {
      const error = { code: 'selector_not_found', message: 'selector_not_found' }
      return { id: 'terminal.stop', ok: false, error, _meta: meta }
    }
    const stopped = liveHostTerminals
    liveHostTerminals = 0
    return { id: 'terminal.stop', ok: true, result: { stopped }, _meta: meta }
  }
  return { id: args.method, ok: true, result: {}, _meta: meta }
}

function seedRemoteProject(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  const worktree = makeWorktree({ id: 'app::/home/me/app', repoId: 'app', hostId: 'runtime:env-1' })
  store.setState({ repos: [remoteRepo], worktreesByRepo: { app: [worktree] } })
  return store
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.mocked(toast.error).mockReset()
  removeForHost.mockReset()
  hostCalls.length = 0
  hostKnowsProject = true
  hostSelectorAmbiguous = false
  liveHostTerminals = 0
  vi.stubGlobal('window', {
    api: {
      repos: { remove: vi.fn(), removeForHost },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: vi.fn(answerLikeRuntimeHost) },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

describe('project removal on a runtime host', () => {
  it('stops the project’s terminals before the host forgets the project', async () => {
    liveHostTerminals = 2
    const store = seedRemoteProject()

    await store.getState().removeProject('app', { hostId: 'runtime:env-1' })

    expect(hostCalls.filter((m) => m === 'terminal.stop' || m === 'repo.rm')).toEqual([
      'terminal.stop',
      'repo.rm'
    ])
    expect(liveHostTerminals).toBe(0)
    expect(store.getState().repos).toEqual([])
  })

  it('still removes the project when a workspace’s terminals cannot be stopped', async () => {
    hostKnowsProject = false
    const store = seedRemoteProject()

    await store.getState().removeProject('app', { hostId: 'runtime:env-1' })

    expect(hostCalls).toContain('repo.rm')
    expect(store.getState().repos).toEqual([])
  })

  it('leaves the shells running when the host will reject the removal', async () => {
    hostSelectorAmbiguous = true
    liveHostTerminals = 2
    const store = seedRemoteProject()

    await store.getState().removeProject('app', { hostId: 'runtime:env-1' })

    expect(hostCalls).not.toContain('terminal.stop')
    expect(liveHostTerminals).toBe(2)
    expect(store.getState().repos).toEqual([remoteRepo])
  })
})

describe('project removal after its server is gone', () => {
  it('drops this desktop’s copy without asking a server that was stopped or forgotten', async () => {
    const call = vi.fn(() => {
      throw new Error('RuntimeEnvironmentStoreError: Unknown environment: env-1')
    })
    vi.stubGlobal('window', {
      api: {
        repos: { remove: vi.fn(), removeForHost },
        pty: { kill: vi.fn() },
        runtimeEnvironments: { call, list: vi.fn(async () => [{ id: 'env-2' }]) },
        ui: { set: vi.fn().mockResolvedValue(undefined) }
      }
    })
    const store = seedRemoteProject()

    await store.getState().removeProject('app', { hostId: 'runtime:env-1', errorFeedback: 'toast' })

    expect(call).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([])
    expect(store.getState().worktreesByRepo.app).toBeUndefined()
  })

  it('still asks the host when the server list cannot be read', async () => {
    vi.stubGlobal('window', {
      api: {
        repos: { remove: vi.fn(), removeForHost },
        pty: { kill: vi.fn() },
        runtimeEnvironments: {
          call: vi.fn(answerLikeRuntimeHost),
          list: vi.fn(async () => {
            throw new Error('profile store unreadable')
          })
        },
        ui: { set: vi.fn().mockResolvedValue(undefined) }
      }
    })
    const store = seedRemoteProject()

    await store.getState().removeProject('app', { hostId: 'runtime:env-1' })

    expect(hostCalls).toContain('repo.rm')
    expect(store.getState().repos).toEqual([])
  })
})

describe('project removal error toast', () => {
  it('shows the host’s message without the IPC wrapper', async () => {
    removeForHost.mockRejectedValue(
      new Error("Error invoking remote method 'repos:removeForHost': Error: Project is busy")
    )
    const store = createTestStore()
    store.setState({ repos: [localRepo] })

    await store.getState().removeProject('app', { hostId: 'local', errorFeedback: 'toast' })

    expect(toast.error).toHaveBeenCalledWith(
      'Failed to remove project',
      expect.objectContaining({ description: 'Project is busy' })
    )
  })
})

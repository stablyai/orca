// Stop runtime project terminals before repo.rm deletes workspace selectors; stopping afterward leaves remote shells running.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from '../testing/app-store-test-fixture'
import { makeWorktree } from '../slices/worktrees/worktree.test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'

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

const hostCalls: string[] = []
let hostKnowsProject = true
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
})

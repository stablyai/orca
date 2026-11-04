/** Host-change refetch and repo_not_found ghost cleanup must isolate owners (#11994). Pin both same-name distinct-ID projects and same-ID cross-host rows; removal may never affect another host. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

const SHARED_NAME = 'Shared Project'

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/hosts/${id}`,
    displayName: SHARED_NAME,
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  } as Repo
}

const reposRemove = vi.fn()
const reposRemoveForHost = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn<(args: RuntimeCall) => unknown>()

type RuntimeCall = RuntimeEnvironmentCallRequest & {
  selector: string
  params?: unknown
}

/** repo.rm answers `code` for `failingSelector`'s environment and succeeds everywhere else. */
function answerRepoRm(options: { failingSelector?: string; code?: string } = {}): void {
  runtimeEnvironmentCall.mockImplementation((args: RuntimeCall) => {
    if (args.method === 'repo.rm' && args.selector === options.failingSelector) {
      return {
        id: 'rpc-repo-rm',
        ok: false,
        error: {
          code: options.code ?? 'repo_not_found',
          message: options.code ?? 'repo_not_found'
        },
        _meta: { runtimeId: `runtime-${args.selector}` }
      }
    }
    return {
      id: 'rpc',
      ok: true,
      result: {},
      _meta: { runtimeId: `runtime-${args.selector}` }
    }
  })
}

function seed(repos: readonly Repo[], activeRuntimeEnvironmentId: string | null = null) {
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId } as never,
    repos: [...repos]
  })
  return store
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  for (const mock of [
    reposRemove,
    reposRemoveForHost,
    runtimeEnvironmentCall,
    runtimeEnvironmentTransportCall
  ]) {
    mock.mockReset()
  }
  runtimeEnvironmentTransportCall.mockImplementation(
    (args) => createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  )
  answerRepoRm()
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

describe('deleting one host copy of a project whose id exists on two hosts', () => {
  const duplicateLocal = repo('dup-id', {
    path: '/laptop/dup',
    executionHostId: 'local'
  })
  const duplicateRemote = repo('dup-id', {
    path: '/mini/dup',
    executionHostId: 'runtime:env-a'
  })

  it('keeps the row when the owner cannot disambiguate a duplicate id', async () => {
    // selector_ambiguous is a real refusal, not missing-project proof; keep row and report failure.
    answerRepoRm({ failingSelector: 'env-a', code: 'selector_ambiguous' })
    const store = seed([duplicateLocal, duplicateRemote], 'env-a')

    await store.getState().removeProject('dup-id', { hostId: 'runtime:env-a' })

    expect(store.getState().repos.map((entry) => entry.path)).toEqual(['/laptop/dup', '/mini/dup'])
  })
})

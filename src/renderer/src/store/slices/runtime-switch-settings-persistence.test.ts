import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { createTestStore } from './store-test-helpers'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { callGitHubTargetOperation } from '@/lib/github-work-item-target-request'
import { setPRFileViewedForRepo } from '@/components/github/github-work-item-comment-mutations'
import { GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY } from '../../../../shared/task-source-runtime-capabilities'

beforeEach(() => clearRuntimeCompatibilityCacheForTests())
afterEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  vi.unstubAllGlobals()
})

function compatibleStatus(runtimeId: string) {
  return {
    ok: true,
    result: {
      runtimeId,
      graphStatus: 'ready',
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    },
    _meta: { runtimeId }
  }
}

it('does not persist a stale overlapping runtime switch', async () => {
  let resolveFirst!: (value: unknown) => void
  const firstStatus = new Promise((resolve) => (resolveFirst = resolve))
  const persistPreference = vi.fn(({ environmentId }: { environmentId: string }) =>
    Promise.resolve({ activeRuntimeEnvironmentId: environmentId })
  )
  vi.stubGlobal('window', {
    api: {
      settings: { setActiveRuntimeEnvironmentPreference: persistPreference },
      runtimeEnvironments: {
        getStatus: vi.fn(({ selector }: { selector: string }) =>
          selector === 'env-a' ? firstStatus : Promise.resolve(compatibleStatus('runtime-b'))
        ),
        call: vi.fn().mockResolvedValue({
          ok: true,
          result: { settings: { worktreeVisibilityDefaults: { external: 'hide' } } },
          _meta: { runtimeId: 'runtime-b' }
        })
      }
    }
  })
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId: null } as never,
    fetchRepos: vi.fn().mockResolvedValue(undefined),
    fetchAllWorktrees: vi.fn().mockResolvedValue(undefined),
    fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined),
    fetchBrowserSessionProfiles: vi.fn().mockResolvedValue(undefined)
  })

  const first = store.getState().setActiveRuntimeEnvironmentPreference('env-a')
  await store.getState().setActiveRuntimeEnvironmentPreference('env-b')
  resolveFirst(compatibleStatus('runtime-a'))
  await first

  expect(persistPreference).toHaveBeenCalledOnce()
  expect(persistPreference).toHaveBeenCalledWith({ environmentId: 'env-b' })
})

it('carries the switch status into no-owner and Viewed dispatch without another status probe', async () => {
  const response = compatibleStatus('runtime-b')
  const observedStatus = {
    ...response,
    result: {
      ...response.result,
      capabilities: [
        WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
        GITHUB_ACCOUNT_EXPECTATION_RUNTIME_CAPABILITY
      ]
    }
  }
  const getStatus = vi.fn().mockResolvedValue(observedStatus)
  const call = vi.fn(async (args: Parameters<typeof window.api.runtimeEnvironments.call>[0]) => ({
    id: args.method,
    ok: true,
    result:
      args.method === 'settings.get'
        ? { settings: { worktreeVisibilityDefaults: { external: 'hide' } } }
        : args.method === 'github.listLabels'
          ? ['bug']
          : true,
    _meta: { runtimeId: 'runtime-b' }
  }))
  vi.stubGlobal('window', {
    api: {
      settings: {
        setActiveRuntimeEnvironmentPreference: vi.fn().mockResolvedValue({
          activeRuntimeEnvironmentId: 'env-b'
        })
      },
      runtimeEnvironments: { getStatus, call },
      gh: { notifyWorkItemMutated: vi.fn().mockResolvedValue(undefined) }
    }
  })
  const store = createTestStore()
  store.setState({
    fetchRepos: vi.fn().mockResolvedValue(undefined),
    fetchAllWorktrees: vi.fn().mockResolvedValue(undefined),
    fetchWorktreeLineage: vi.fn().mockResolvedValue(undefined),
    fetchBrowserSessionProfiles: vi.fn().mockResolvedValue(undefined)
  })
  await expect(store.getState().setActiveRuntimeEnvironmentPreference('env-b')).resolves.toBe(true)

  const target = { kind: 'environment', environmentId: 'env-b' } as const
  const expectedGhAccount = { host: 'github.com', user: 'alice' }
  const local = vi.fn()
  await expect(
    callGitHubTargetOperation<string[]>({
      target,
      method: 'github.listLabels',
      params: { repo: 'repo' },
      expectedGhAccount,
      read: true,
      local
    })
  ).resolves.toEqual(['bug'])
  await expect(
    setPRFileViewedForRepo({
      target,
      repoId: 'repo',
      repoPath: '/repo',
      prNumber: 7,
      pullRequestId: 'pr7',
      path: 'file.ts',
      viewed: true,
      expectedGhAccount
    })
  ).resolves.toBe(true)
  expect(getStatus).toHaveBeenCalledExactlyOnceWith({ selector: 'env-b', timeoutMs: 15_000 })
  expect(call).not.toHaveBeenCalledWith(expect.objectContaining({ method: 'status.get' }))
  expect(local).not.toHaveBeenCalled()
  expect(
    call.mock.calls.map(([args]) => args).filter(({ method }) => method.startsWith('github.'))
  ).toEqual([
    expect.objectContaining({
      selector: 'env-b',
      method: 'github.listLabels',
      expectedEnvironmentRuntimeId: 'runtime-b',
      params: { repo: 'repo', expectedGhAccount }
    }),
    expect.objectContaining({
      selector: 'env-b',
      method: 'github.setPRFileViewed',
      expectedEnvironmentRuntimeId: 'runtime-b',
      params: {
        repo: 'repo',
        prRepo: null,
        pullRequestId: 'pr7',
        path: 'file.ts',
        viewed: true,
        expectedGhAccount
      }
    })
  ])
})

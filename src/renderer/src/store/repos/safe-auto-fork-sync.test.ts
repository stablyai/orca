import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { safeAutoForkSyncAttempts, scheduleSafeAutoForkSync } from './safe-auto-fork-sync'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const gitSyncFork = vi.fn()

const RUNTIME_REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo-1',
  displayName: 'repo-1',
  badgeColor: '#000000',
  addedAt: 0,
  kind: 'git',
  executionHostId: 'runtime:env-1',
  forkSyncMode: 'safe-auto',
  upstream: { owner: 'up', repo: 'r' }
}

async function flushScheduledSyncs(): Promise<void> {
  await Promise.all([...safeAutoForkSyncAttempts.values()].map((attempt) => attempt.promise))
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  safeAutoForkSyncAttempts.clear()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  gitSyncFork.mockReset()
  gitSyncFork.mockResolvedValue({ status: 'up-to-date', behind: 0 })
  runtimeEnvironmentCall.mockResolvedValue({
    id: 'rpc-1',
    ok: true,
    result: { status: 'up-to-date', behind: 0 },
    _meta: { runtimeId: 'remote-runtime' }
  })
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      git: { syncFork: gitSyncFork },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('scheduleSafeAutoForkSync', () => {
  it('bounds completed attempt history under repo churn', async () => {
    const repos = Array.from({ length: 600 }, (_, index) => ({
      ...RUNTIME_REPO,
      id: `repo-${index}`,
      path: `/srv/repo-${index}`
    }))

    scheduleSafeAutoForkSync(repos)
    await flushScheduledSyncs()

    expect(safeAutoForkSyncAttempts.size).toBeLessThanOrEqual(512)
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
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

function stateWith(repo: Repo): AppState {
  return {
    repos: [repo],
    settings: { activeRuntimeEnvironmentId: 'env-1' }
  } as unknown as AppState
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
  it('addresses a runtime-hosted repo by its main worktree id, not the bare repo id', async () => {
    // Why: the runtime rejects `id:<repo-id>` with worktree_id_requires_full_path (#16447).
    scheduleSafeAutoForkSync(() => stateWith(RUNTIME_REPO), [RUNTIME_REPO])
    await flushScheduledSyncs()

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'git.forkSync',
        params: expect.objectContaining({ worktree: 'id:repo-1::/srv/repo-1' })
      })
    )
  })

  it('still runs local repos against the repo path over local git IPC', async () => {
    const localRepo: Repo = {
      ...RUNTIME_REPO,
      id: 'repo-2',
      path: '/home/me/repo-2',
      executionHostId: 'local'
    }

    scheduleSafeAutoForkSync(
      () =>
        ({ ...stateWith(localRepo), settings: { activeRuntimeEnvironmentId: null } }) as AppState,
      [localRepo]
    )
    await flushScheduledSyncs()

    expect(gitSyncFork).toHaveBeenCalledWith({
      worktreePath: '/home/me/repo-2',
      connectionId: undefined,
      expectedUpstream: { owner: 'up', repo: 'r' }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})

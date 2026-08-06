import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'
import { persistWorktreeSortOrderByHost } from './worktree-sort-order-persistence'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

const localPersistSortOrder = vi.fn()
const runtimeCall = vi.mocked(callRuntimeRpc)
const UNHANDLED_REJECTION_SETTLE_MS = 20

const state: WorktreeRuntimeOwnerState = {
  settings: { activeRuntimeEnvironmentId: 'focused-env' },
  repos: [
    { id: 'local-repo', connectionId: null, executionHostId: 'local' },
    { id: 'runtime-repo', connectionId: null, executionHostId: 'runtime:env-1' }
  ],
  worktreesByRepo: {
    'local-repo': [{ id: 'local-repo::wt-a', repoId: 'local-repo' }],
    'runtime-repo': [{ id: 'runtime-repo::wt-b', repoId: 'runtime-repo' }]
  }
}

async function collectUnhandledRejections(run: () => void): Promise<unknown[]> {
  const reasons: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => {
    reasons.push(reason)
  }

  process.on('unhandledRejection', onUnhandledRejection)
  try {
    run()
    await new Promise((resolve) => setTimeout(resolve, UNHANDLED_REJECTION_SETTLE_MS))
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }

  return reasons
}

beforeEach(() => {
  runtimeCall.mockReset()
  localPersistSortOrder.mockReset()
  runtimeCall.mockResolvedValue(undefined)
  localPersistSortOrder.mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      worktrees: {
        persistSortOrder: localPersistSortOrder
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('persistWorktreeSortOrderByHost', () => {
  it('persists each owner host through the matching transport', () => {
    persistWorktreeSortOrderByHost(state, ['runtime-repo::wt-b', 'local-repo::wt-a'])

    expect(runtimeCall).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'worktree.persistSortOrder',
      { orderedIds: ['runtime-repo::wt-b'] },
      { timeoutMs: 15_000 }
    )
    expect(localPersistSortOrder).toHaveBeenCalledWith({ orderedIds: ['local-repo::wt-a'] })
  })

  it('handles best-effort persistence rejections from disconnected hosts', async () => {
    runtimeCall.mockRejectedValueOnce(new Error('SSH disconnected'))
    localPersistSortOrder.mockRejectedValueOnce(new Error('local store unavailable'))

    const unhandledRejections = await collectUnhandledRejections(() => {
      persistWorktreeSortOrderByHost(state, ['runtime-repo::wt-b', 'local-repo::wt-a'])
    })

    expect(unhandledRejections).toEqual([])
  })
})

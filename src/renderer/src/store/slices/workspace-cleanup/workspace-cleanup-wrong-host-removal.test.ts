import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ExecutionHostId } from '../../../../../shared/execution-host'

const HOST_A_HOST_ID: ExecutionHostId = 'local'
const HOST_B_HOST_ID: ExecutionHostId = 'ssh:ssh-1'

const mockApi = {
  worktrees: {
    remove: vi.fn(),
    forgetLocal: vi.fn().mockResolvedValue({ ok: false, error: 'unused in this scenario' })
  },
  hooks: {
    check: vi.fn().mockResolvedValue({ hasHooks: false, hooks: null, mayNeedUpdate: false })
  },
  workspaceCleanup: {
    scan: vi.fn(),
    dismiss: vi.fn().mockResolvedValue(undefined),
    clearDismissals: vi.fn().mockResolvedValue(undefined),
    recordRemovalSnapshotPrune: vi.fn().mockResolvedValue(undefined)
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} } as never) },
  ephemeralVm: {
    listRuntimes: vi.fn().mockResolvedValue([]),
    cleanup: vi.fn().mockResolvedValue({})
  }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

const runtimeRpc = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: runtimeRpc.callRuntimeRpc
}))

import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'
import { makeWorktree } from '../worktrees/worktree.test-fixture'
import { resetAuthoritativelyRemovedWorktreeMemoryForTests } from '../worktrees/listing/authoritative-worktree-removal-memory'
import type { AppState } from '../../types'
import type { DetectedWorktree, Worktree } from '../../../../../shared/worktree/types'

function makeDetectedWorktree(
  overrides: Partial<Worktree> & { id: string; repoId: string }
): DetectedWorktree {
  return {
    ...makeWorktree(overrides),
    ownership: 'orca-managed',
    selectedCheckout: false,
    visible: true
  }
}

const hostDirCleanup: (() => void)[] = []

beforeEach(() => {
  resetAuthoritativelyRemovedWorktreeMemoryForTests()
  mockApi.ephemeralVm.listRuntimes.mockResolvedValue([])
  mockApi.ephemeralVm.cleanup.mockResolvedValue({})
})

afterEach(() => {
  vi.clearAllMocks()
  for (const cleanup of hostDirCleanup.splice(0)) {
    cleanup()
  }
})

describe('STA-4343 wrong-host cleanup removal (git worktree identity)', () => {
  it('preserves a same-id host row published while removal is in flight', async () => {
    const worktreeId = 'repo1::/shared/workspace/path'
    const worktreePath = '/shared/workspace/path'
    const original = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: worktreePath,
      hostId: HOST_A_HOST_ID
    })
    const arriving = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: worktreePath,
      hostId: HOST_B_HOST_ID
    })
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: { repo1: [original] },
      detectedWorktreesByRepo: {
        repo1: {
          repoId: 'repo1',
          authoritative: true,
          source: 'git',
          worktrees: [makeDetectedWorktree(original)]
        }
      },
      tabsByWorktree: {
        [worktreeId]: [makeTab({ id: 'arriving-host-tab', worktreeId })]
      }
    } as Partial<AppState>)
    mockApi.worktrees.remove.mockImplementationOnce(async () => {
      store.setState({
        worktreesByRepo: { repo1: [original, arriving] },
        detectedWorktreesByRepo: {
          repo1: {
            repoId: 'repo1',
            authoritative: true,
            source: 'git',
            worktrees: [makeDetectedWorktree(original), makeDetectedWorktree(arriving)]
          }
        }
      })
      return { ok: true }
    })

    const result = await store
      .getState()
      .removeWorktree({ id: worktreeId, executionHostId: HOST_A_HOST_ID })

    expect(result).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo.repo1).toEqual([arriving])
    expect(store.getState().tabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'arriving-host-tab' })
    ])
  })
})

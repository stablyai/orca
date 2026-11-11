import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../../../runtime/rpc/compatibility/runtime-compatibility-cache'
import 'sonner'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeLayout, makeTab } from '../../../terminals/terminal-tab.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { saveSessionCommitDrafts } from '@/lib/source-control/drafts/source-control-commit-draft-session'
import { createStoreCascadesMockApi } from '../../../testing/app-store-cascade-api.test-fixture'
import '../../../../../../shared/worktree/host-qualified-identity'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('removeWorktree cascade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    saveSessionCommitDrafts({})
    mockApi.worktrees.remove.mockResolvedValue(undefined)
    mockApi.worktrees.forceDeletePreservedBranch.mockResolvedValue({ deleted: true })
    mockApi.runtimeEnvironments.call.mockReset()
    mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) =>
      Promise.resolve(
        createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
          id: 'rpc-default',
          ok: true,
          result: {},
          _meta: { runtimeId: 'remote-runtime' }
        }
      )
    )
  })

  it('sets delete state with dirty/untracked error and canForceDelete=true on failure', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const error = 'Worktree has uncommitted or untracked changes.'

    mockApi.worktrees.remove.mockRejectedValueOnce(new Error(error))

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })]
      },
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'tab1', worktreeId })] },
      ptyIdsByTabId: { tab1: ['pty1'] },
      terminalLayoutsByTabId: { tab1: makeLayout() },
      activeWorktreeId: worktreeId,
      activeTabId: 'tab1'
    })

    const result = await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    const s = store.getState()

    expect(result).toEqual({ ok: false, error })
    expect(s.deleteStateByWorktreeId[worktreeId]).toEqual({
      isDeleting: false,
      error,
      canForceDelete: true,
      forceDeleteReason: 'dirty'
    })
    expect(s.worktreesByRepo['repo1']).toHaveLength(1)
    expect(s.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(s.ptyIdsByTabId['tab1']).toEqual(['pty1'])
    expect(mockApi.pty.kill).not.toHaveBeenCalled()
    expect(s.activeWorktreeId).toBe(worktreeId)
  })
})

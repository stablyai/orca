/** Purge module-level ambiguous-owner warning keys on both removal paths. Otherwise IDs leak forever and recreated workspaces cannot report newly ambiguous ownership. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn().mockResolvedValue({ ok: true, result: {} }) }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import {
  ambiguousOwnerWarnedWorktreeIds,
  warnAmbiguousOwnerOnce
} from '@/lib/ambiguous-owner-warning'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'

function seedWorktrees(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
      ]
    }
  })
}

describe('ambiguous-owner warning set is pruned on worktree removal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ambiguousOwnerWarnedWorktreeIds.clear()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
  })

  it('re-arms the once-per-workspace warning after remove and re-add', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createTestStore()
    seedWorktrees(store)

    warnAmbiguousOwnerOnce(WT1, 'persist worktree activity timestamp')
    warnAmbiguousOwnerOnce(WT1, 'persist worktree activity timestamp')
    expect(warn).toHaveBeenCalledTimes(1)

    await store.getState().removeWorktree({ id: WT1, executionHostId: null })
    seedWorktrees(store)

    warnAmbiguousOwnerOnce(WT1, 'persist worktree activity timestamp')

    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('re-arms only the purged workspace warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createTestStore()
    seedWorktrees(store)
    warnAmbiguousOwnerOnce(WT1, 'persist worktree activity timestamp')
    warnAmbiguousOwnerOnce(WT2, 'persist worktree activity timestamp')

    store.getState().purgeWorktreeTerminalState([WT1])

    warn.mockClear()
    warnAmbiguousOwnerOnce(WT2, 'persist worktree activity timestamp')
    expect(warn).not.toHaveBeenCalled()
    warnAmbiguousOwnerOnce(WT1, 'persist worktree activity timestamp')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

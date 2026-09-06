/**
 * Memory-leak + correctness regression: `ambiguousOwnerWarnedWorktreeIds` is a
 * module-scope Set that had no `delete` anywhere.
 *
 * `warnAmbiguousOwnerOnce` adds a worktree id so the "identity is ambiguous
 * across hosts" warning is emitted once per workspace rather than on every PTY
 * activity bump. Both removal paths prune ~20 other per-worktree collections and
 * skipped this one, so ids accumulated for the life of the renderer — and, because
 * membership is what suppresses the warning, a workspace whose id came back (paths
 * are recreated, so worktree ids are recycled) could never warn again even when it
 * was genuinely ambiguous a second time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
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
} from './worktrees/listing/worktree-owner-settings'
import { createTestStore, seedStore, makeWorktree } from './store-test-helpers'

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

  it('drops the warned id on single removeWorktree, for the removed worktree only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createTestStore()
    seedWorktrees(store)
    warnAmbiguousOwnerOnce(WT1, 'persist worktree activity timestamp')
    warnAmbiguousOwnerOnce(WT2, 'persist worktree activity timestamp')
    expect(ambiguousOwnerWarnedWorktreeIds.size).toBe(2)

    const result = await store.getState().removeWorktree({ id: WT1, executionHostId: null })
    expect(result).toEqual({ ok: true })

    expect(ambiguousOwnerWarnedWorktreeIds.has(WT1)).toBe(false)
    expect(ambiguousOwnerWarnedWorktreeIds.has(WT2)).toBe(true)
    expect(ambiguousOwnerWarnedWorktreeIds.size).toBe(1)
    warn.mockRestore()
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

  it('drops warned ids on the bulk purge path too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createTestStore()
    seedWorktrees(store)
    warnAmbiguousOwnerOnce(WT1, 'persist worktree activity timestamp')
    warnAmbiguousOwnerOnce(WT2, 'persist worktree activity timestamp')

    store.getState().purgeWorktreeTerminalState([WT1])

    expect(ambiguousOwnerWarnedWorktreeIds.has(WT1)).toBe(false)
    expect(ambiguousOwnerWarnedWorktreeIds.has(WT2)).toBe(true)
    warn.mockRestore()
  })

  it('does not accumulate across many remove cycles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = createTestStore()
    for (let index = 0; index < 100; index += 1) {
      const worktreeId = `repo1::/path/cycle-${index}`
      seedStore(store, {
        worktreesByRepo: {
          repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: `/path/cycle-${index}` })]
        }
      })
      warnAmbiguousOwnerOnce(worktreeId, 'persist worktree activity timestamp')
      await store.getState().removeWorktree({ id: worktreeId, executionHostId: null })
    }

    expect(ambiguousOwnerWarnedWorktreeIds.size).toBe(0)
    warn.mockRestore()
  })
})

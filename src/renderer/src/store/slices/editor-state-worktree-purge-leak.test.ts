/**
 * Memory-leak regression: per-file and per-worktree editor state must be purged
 * when a worktree is removed.
 *
 * `editorCursorLine` and `editorViewMode` are keyed by fileId and
 * `gitStatusHugeByWorktree` is keyed by worktreeId. Both worktree-removal paths
 * — the bulk `purgeWorktreeTerminalState` (used by the authoritative-scan
 * reconcile) and the single `removeWorktree` — failed to drop these entries, so
 * they accumulated one record per file/worktree for the lifetime of the
 * renderer session.
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

import { createTestStore, seedStore, makeWorktree, makeOpenFile } from './store-test-helpers'

const WT = 'repo1::/path/wt1'
const FILE_A = '/path/wt1/a.ts'
const FILE_B = '/path/wt1/b.ts'

function seedEditorState(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]
    },
    openFiles: [
      makeOpenFile({ id: FILE_A, worktreeId: WT }),
      makeOpenFile({ id: FILE_B, worktreeId: WT })
    ],
    editorCursorLine: { [FILE_A]: 12, [FILE_B]: 4 },
    editorViewMode: { [FILE_A]: 'changes', [FILE_B]: 'edit' },
    gitStatusHugeByWorktree: { [WT]: { limit: 1000 } }
  })
}

describe('worktree removal purges per-file editor + git-huge state (leak regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
  })

  it('bulk purgeWorktreeTerminalState drops editor + git-huge state for the removed worktree', () => {
    const store = createTestStore()
    seedEditorState(store)

    store.getState().purgeWorktreeTerminalState([WT])

    const s = store.getState()
    expect(s.editorCursorLine[FILE_A]).toBeUndefined()
    expect(s.editorCursorLine[FILE_B]).toBeUndefined()
    expect(s.editorViewMode[FILE_A]).toBeUndefined()
    expect(s.editorViewMode[FILE_B]).toBeUndefined()
    expect(s.gitStatusHugeByWorktree[WT]).toBeUndefined()
  })

  it('single removeWorktree drops editor + git-huge state for the removed worktree', async () => {
    const store = createTestStore()
    seedEditorState(store)

    const result = await store.getState().removeWorktree(WT)
    expect(result).toEqual({ ok: true })

    const s = store.getState()
    expect(s.editorCursorLine[FILE_A]).toBeUndefined()
    expect(s.editorCursorLine[FILE_B]).toBeUndefined()
    expect(s.editorViewMode[FILE_A]).toBeUndefined()
    expect(s.gitStatusHugeByWorktree[WT]).toBeUndefined()
  })

  it('keeps editor + git-huge state for worktrees that are NOT removed', () => {
    const store = createTestStore()
    const OTHER = 'repo1::/path/wt2'
    const OTHER_FILE = '/path/wt2/keep.ts'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: OTHER, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      openFiles: [
        makeOpenFile({ id: FILE_A, worktreeId: WT }),
        makeOpenFile({ id: OTHER_FILE, worktreeId: OTHER })
      ],
      editorCursorLine: { [FILE_A]: 12, [OTHER_FILE]: 7 },
      editorViewMode: { [FILE_A]: 'changes', [OTHER_FILE]: 'edit' },
      gitStatusHugeByWorktree: { [WT]: { limit: 1000 }, [OTHER]: { limit: 2000 } }
    })

    store.getState().purgeWorktreeTerminalState([WT])

    const s = store.getState()
    expect(s.editorCursorLine[OTHER_FILE]).toBe(7)
    expect(s.editorViewMode[OTHER_FILE]).toBe('edit')
    expect(s.gitStatusHugeByWorktree[OTHER]).toEqual({ limit: 2000 })
  })
})

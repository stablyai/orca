/**
 * Teardown coverage for `nativeChatLaunchDraftByTabId`.
 *
 * A stranded entry is worse than a plain leak: sync-runtime-graph keeps
 * publishing it to mobile as that tab's `launchDraft`. It must evict wherever
 * its sibling `nativeChatLaunchPromptByTabId` does — tab close, orphan sweep,
 * the bulk worktree purge, and the single removeWorktree teardown.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { buildOrphanTerminalCleanupPatch } from './terminal-orphan-helpers'

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

import { createTestStore, seedStore, makeWorktree, makeTab } from './store-test-helpers'

const WT1 = 'repo1::/path/wt1'
const WT2 = 'repo1::/path/wt2'
const TAB1 = 'tab-wt1'
const TAB2 = 'tab-wt2'

function draft(tabId: string, text: string) {
  return { tabId, agent: 'claude' as const, text, createdAt: 1 }
}

function seedDrafts(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT1, repoId: 'repo1', path: '/path/wt1' }),
        makeWorktree({ id: WT2, repoId: 'repo1', path: '/path/wt2' })
      ]
    },
    tabsByWorktree: {
      [WT1]: [makeTab({ id: TAB1, worktreeId: WT1 })],
      [WT2]: [makeTab({ id: TAB2, worktreeId: WT2 })]
    },
    nativeChatLaunchDraftByTabId: {
      [TAB1]: draft(TAB1, 'https://github.com/o/r/issues/1'),
      [TAB2]: draft(TAB2, 'https://github.com/o/r/issues/2')
    }
  })
}

describe('nativeChatLaunchDraftByTabId teardown', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
  })

  it('closeTab drops the closed tab’s draft only', () => {
    const store = createTestStore()
    seedDrafts(store)

    store.getState().closeTab(TAB1)

    const s = store.getState()
    expect(s.nativeChatLaunchDraftByTabId[TAB1]).toBeUndefined()
    expect(s.nativeChatLaunchDraftByTabId[TAB2]).toBeDefined()
  })

  it('bulk purgeWorktreeTerminalState drops drafts for the removed worktree only', () => {
    const store = createTestStore()
    seedDrafts(store)

    store.getState().purgeWorktreeTerminalState([WT1])

    const s = store.getState()
    expect(s.nativeChatLaunchDraftByTabId[TAB1]).toBeUndefined()
    expect(s.nativeChatLaunchDraftByTabId[TAB2]).toBeDefined()
  })

  it('single removeWorktree drops drafts for the removed worktree only', async () => {
    const store = createTestStore()
    seedDrafts(store)

    const result = await store.getState().removeWorktree(WT1)

    expect(result).toEqual({ ok: true })
    const s = store.getState()
    expect(s.nativeChatLaunchDraftByTabId[TAB1]).toBeUndefined()
    expect(s.nativeChatLaunchDraftByTabId[TAB2]).toBeDefined()
  })

  it('persists the adopted flag, idempotently, and clears the whole entry', () => {
    // Every consumer test injects these reducers as bare vi.fn()s. `adopted` is
    // what stops a manually cleared composer from resurrecting the prefill, so
    // assert the real reducers here.
    const store = createTestStore()
    store.getState().seedNativeChatLaunchDraft(draft(TAB1, 'https://github.com/o/r/issues/1'))
    expect(store.getState().nativeChatLaunchDraftByTabId[TAB1]?.adopted).toBeUndefined()

    store.getState().markNativeChatLaunchDraftAdopted(TAB1)
    const adopted = store.getState().nativeChatLaunchDraftByTabId[TAB1]
    expect(adopted).toMatchObject({ tabId: TAB1, adopted: true })

    store.getState().markNativeChatLaunchDraftAdopted(TAB1)
    expect(store.getState().nativeChatLaunchDraftByTabId[TAB1]).toBe(adopted)

    store.getState().clearNativeChatLaunchDraft(TAB1)
    expect(TAB1 in store.getState().nativeChatLaunchDraftByTabId).toBe(false)
  })

  it('resolves only the exact draft generation', () => {
    const store = createTestStore()
    const entry = draft(TAB1, 'same text')
    store.getState().seedNativeChatLaunchDraft(entry)

    store.getState().resolveNativeChatLaunchDraft(TAB1, { text: entry.text, createdAt: 0 })
    expect(store.getState().nativeChatLaunchDraftByTabId[TAB1]?.resolved).toBeUndefined()

    store.getState().resolveNativeChatLaunchDraft(TAB1, {
      text: entry.text,
      createdAt: entry.createdAt
    })
    expect(store.getState().nativeChatLaunchDraftByTabId[TAB1]?.resolved).toBe(true)
  })

  it('the orphan terminal cleanup patch drops swept tabs’ drafts only', () => {
    const store = createTestStore()
    seedDrafts(store)

    const patch = buildOrphanTerminalCleanupPatch(store.getState(), WT1, new Set([TAB1]))

    expect(patch.nativeChatLaunchDraftByTabId[TAB1]).toBeUndefined()
    expect(patch.nativeChatLaunchDraftByTabId[TAB2]).toBeDefined()
  })
})

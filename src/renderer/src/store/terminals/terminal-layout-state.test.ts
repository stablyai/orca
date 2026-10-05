import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { createTestStore } from '../slices/store-test-helpers'
import type * as WorktreeRuntimeOwner from '@/lib/worktree-runtime-owner'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const LOCAL_WT = 'repo1::/tmp/local'
const PAIRED_WT = 'repo1::/tmp/paired'

vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwner>()
  return {
    ...actual,
    getRuntimeEnvironmentIdForWorktree: (
      state: Parameters<typeof actual.getRuntimeEnvironmentIdForWorktree>[0],
      worktreeId: string | null | undefined
    ) =>
      worktreeId === PAIRED_WT
        ? 'env-1'
        : actual.getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
})

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

function splitLayout(chatLeafId?: string): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: A },
      second: { type: 'leaf', leafId: B }
    },
    activeLeafId: A,
    expandedLeafId: null,
    ...(chatLeafId ? { chatLeafId } : {})
  }
}

function soleLayout(leafId: string, chatLeafId?: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ...(chatLeafId ? { chatLeafId } : {})
  }
}

describe('setTabLayout chat owner rule', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    // @ts-expect-error -- partial window stub is sufficient for these store-only tests
    globalThis.window = { api: { ui: { set: vi.fn() } } }
    store = createTestStore()
  })

  function createSplitTab(worktreeId: string, pair?: { viewMode: 'chat'; owner: string }) {
    const tab = store.getState().createTab(worktreeId, undefined, undefined, {})
    store.getState().setTabLayout(tab.id, splitLayout())
    if (pair) {
      store.getState().applyTerminalChatPair(tab.id, pair.owner, pair.viewMode)
    }
    return tab.id
  }

  function pairOf(tabId: string) {
    const state = store.getState()
    const row = Object.values(state.tabsByWorktree)
      .flat()
      .find((tab) => tab.id === tabId)
    const unified = Object.values(state.unifiedTabsByWorktree)
      .flat()
      .find((tab) => tab.entityId === tabId)
    return {
      row: row?.viewMode,
      unified: unified?.viewMode,
      owner: state.terminalLayoutsByTabId[tabId]?.chatLeafId
    }
  }

  it('writes the whole pair in one store update', () => {
    const tabId = createSplitTab(LOCAL_WT)
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    expect(store.getState().applyTerminalChatPair(tabId, B, 'chat')).toEqual({
      viewMode: 'chat',
      chatLeafId: B
    })

    unsubscribe()
    expect(listener).toHaveBeenCalledOnce()
    expect(pairOf(tabId)).toEqual({ row: 'chat', unified: 'chat', owner: B })
  })

  it('keeps the stored owner when a layout write carries another', () => {
    const tabId = createSplitTab(LOCAL_WT, { viewMode: 'chat', owner: B })
    store.getState().setTabLayout(tabId, splitLayout(A))
    expect(pairOf(tabId)).toEqual({ row: 'chat', unified: 'chat', owner: B })
    store.getState().setTabLayout(tabId, splitLayout())
    expect(pairOf(tabId)).toEqual({ row: 'chat', unified: 'chat', owner: B })
  })

  it('leaves chat in the same update when the tree drops the owner', () => {
    const tabId = createSplitTab(LOCAL_WT, { viewMode: 'chat', owner: A })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.getState().setTabLayout(tabId, soleLayout(B, A))

    unsubscribe()
    expect(listener).toHaveBeenCalledOnce()
    expect(pairOf(tabId)).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
  })

  it('seeds a first layout and fills in an owner only for a chat that has none', () => {
    const chatTab = store.getState().createTab(LOCAL_WT, undefined, undefined, {
      viewMode: 'chat'
    })
    store.getState().setTabLayout(chatTab.id, splitLayout(B))
    expect(pairOf(chatTab.id)).toEqual({ row: 'chat', unified: 'chat', owner: B })

    const terminalTab = store.getState().createTab(LOCAL_WT, undefined, undefined, {})
    store.getState().setTabLayout(terminalTab.id, splitLayout(B))
    expect(pairOf(terminalTab.id).owner).toBeUndefined()
  })

  it('keeps the incoming owner on a paired worktree', () => {
    const tabId = createSplitTab(PAIRED_WT, { viewMode: 'chat', owner: B })
    store.getState().setTabLayout(tabId, splitLayout(A))
    expect(pairOf(tabId).owner).toBe(A)
    store.getState().setTabLayout(tabId, soleLayout(B))
    expect(pairOf(tabId)).toEqual({ row: 'chat', unified: 'chat', owner: undefined })
  })
})

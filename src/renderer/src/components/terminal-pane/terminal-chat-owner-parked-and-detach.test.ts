import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'
import { collapseParkedTerminalLeaf } from './terminal-parked-pty-watcher'
import { detachTerminalPaneToTab } from './terminal-pane-tab-detach'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const WT = 'repo1::/tmp/local'
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
    ptyIdsByLeafId: { [A]: 'pty-a', [B]: 'pty-b' },
    ...(chatLeafId ? { chatLeafId } : {})
  }
}

function seedChatTab(owner: string): string {
  const tab = useAppStore.getState().createTab(WT, undefined, undefined, {})
  useAppStore.getState().setTabLayout(tab.id, splitLayout())
  useAppStore.getState().applyTerminalChatPair(tab.id, owner, 'chat')
  return tab.id
}

function pairOf(tabId: string) {
  const state = useAppStore.getState()
  return {
    row: state.tabsByWorktree[WT]?.find((tab) => tab.id === tabId)?.viewMode,
    unified: state.unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === tabId)?.viewMode,
    owner: state.terminalLayoutsByTabId[tabId]?.chatLeafId
  }
}

beforeEach(() => {
  // @ts-expect-error -- partial window stub is sufficient for these store-backed tests
  globalThis.window = { api: { ui: { set: vi.fn() } } }
  useAppStore.setState({
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    terminalLayoutsByTabId: {}
  })
})

describe('parked (unmounted) pane close', () => {
  it('turns the tab to terminal when the owning pane closes', () => {
    const tabId = seedChatTab(A)
    collapseParkedTerminalLeaf(tabId, A, 'pty-a')
    expect(pairOf(tabId)).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
  })

  it('keeps chat when a non-owning pane closes', () => {
    const tabId = seedChatTab(A)
    collapseParkedTerminalLeaf(tabId, B, 'pty-b')
    expect(pairOf(tabId)).toEqual({ row: 'chat', unified: 'chat', owner: A })
  })
})

describe('detaching the owning pane into a new tab', () => {
  it('moves chat with the leaf: the source turns terminal and the new tab owns it', () => {
    const sourceTabId = seedChatTab(B)
    const groupId = useAppStore.getState().groupsByWorktree[WT]![0]!.id
    const panes = [
      { id: 1, leafId: A },
      { id: 2, leafId: B }
    ]

    const detached = detachTerminalPaneToTab({
      getStore: () => useAppStore.getState(),
      manager: {
        getPanes: () => panes,
        getLeafId: (paneId) => panes.find((pane) => pane.id === paneId)?.leafId ?? null,
        detachPaneForExternalMove: () => true
      },
      persistLayoutSnapshot: () => {},
      sourcePaneId: 2,
      sourceTabId,
      targetGroupId: groupId,
      worktreeId: WT
    })

    expect(pairOf(sourceTabId)).toEqual({ row: 'terminal', unified: 'terminal', owner: undefined })
    expect(pairOf(detached!.tab.id)).toEqual({ row: 'chat', unified: 'chat', owner: B })
  })
})

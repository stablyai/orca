import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppState } from '../types'
import { createTestStore, makeUnifiedTab, makeTabGroup } from './store-test-helpers'

// Mock sonner (imported transitively by repos.ts via the full store).
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const mockApi = {
  ui: { set: vi.fn().mockResolvedValue(undefined) },
  settings: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) }
}

// @ts-expect-error -- partial window stub is sufficient for these store-only tests
globalThis.window = { api: mockApi }

const WT = 'repo1::/tmp/feature'

function seedTwoLeafTabs(store: ReturnType<typeof createTestStore>): void {
  const left = makeUnifiedTab({ id: 'left-tab', worktreeId: WT, groupId: 'g-left' })
  const right = makeUnifiedTab({ id: 'right-tab', worktreeId: WT, groupId: 'g-right' })
  store.setState({
    unifiedTabsByWorktree: { [WT]: [left, right] },
    groupsByWorktree: {
      [WT]: [
        makeTabGroup({
          id: 'g-left',
          worktreeId: WT,
          activeTabId: 'left-tab',
          tabOrder: ['left-tab']
        }),
        makeTabGroup({
          id: 'g-right',
          worktreeId: WT,
          activeTabId: 'right-tab',
          tabOrder: ['right-tab']
        })
      ]
    }
  } as Partial<AppState>)
}

function findTab(store: ReturnType<typeof createTestStore>, tabId: string) {
  return store.getState().unifiedTabsByWorktree[WT].find((tab) => tab.id === tabId)
}

describe('tab view mode', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
    seedTwoLeafTabs(store)
  })

  it('toggles a tab to chat and back to terminal', () => {
    expect(findTab(store, 'left-tab')?.viewMode).toBeUndefined()

    store.getState().toggleTabViewMode('left-tab')
    expect(findTab(store, 'left-tab')?.viewMode).toBe('chat')

    store.getState().toggleTabViewMode('left-tab')
    expect(findTab(store, 'left-tab')?.viewMode).toBe('terminal')
  })

  it('setTabViewMode sets an explicit mode', () => {
    store.getState().setTabViewMode('left-tab', 'chat')
    expect(findTab(store, 'left-tab')?.viewMode).toBe('chat')
    store.getState().setTabViewMode('left-tab', 'terminal')
    expect(findTab(store, 'left-tab')?.viewMode).toBe('terminal')
  })

  it('mutates only the targeted tab, leaving a split sibling unchanged', () => {
    store.getState().toggleTabViewMode('left-tab')

    expect(findTab(store, 'left-tab')?.viewMode).toBe('chat')
    // The sibling leaf's tab keeps its (default) view mode.
    expect(findTab(store, 'right-tab')?.viewMode).toBeUndefined()
  })

  it('is a no-op for an unknown tab id', () => {
    const before = store.getState().unifiedTabsByWorktree[WT]
    store.getState().toggleTabViewMode('missing-tab')
    expect(store.getState().unifiedTabsByWorktree[WT]).toBe(before)
  })
})

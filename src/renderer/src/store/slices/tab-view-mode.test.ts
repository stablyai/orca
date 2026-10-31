// Paired-server view-mode toggles stay window-owned; local frame-owned coverage: workspace-layout-frame-held-tabs.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppState } from '../types'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeUnifiedTab,
  makeTabGroup
} from './store-test-helpers'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('@/runtime/web-runtime-terminal-actions', () => ({ setWebRuntimeTabProps: vi.fn() }))

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
    worktreesByRepo: { repo1: [makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1' })] }
  })
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

  it('mutates only the targeted tab, leaving a split sibling unchanged', async () => {
    store.getState().toggleTabViewMode('left-tab')
    await layoutApplyTestTransport.settle()

    expect(findTab(store, 'left-tab')?.viewMode).toBe('chat')
    expect(findTab(store, 'right-tab')?.viewMode).toBeUndefined()
  })

  // Local toggles must mirror viewMode onto terminal rows used by recovery, matching host sync.
  describe('mirrors onto the terminal row', () => {
    function terminalRow(tabId: string) {
      return store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === tabId)
    }

    beforeEach(() => {
      const tabId = store.getState().createTab(WT).id
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            ...store.getState().unifiedTabsByWorktree[WT].filter((tab) => tab.id !== tabId),
            makeUnifiedTab({ id: tabId, entityId: tabId, worktreeId: WT, groupId: 'g-left' })
          ]
        }
      } as Partial<AppState>)
      rowTabId = tabId
    })

    let rowTabId = ''

    it('toggleTabViewMode patches the row in the same write', async () => {
      store.getState().toggleTabViewMode(rowTabId)
      await layoutApplyTestTransport.settle()
      expect(terminalRow(rowTabId)?.viewMode).toBe('chat')

      store.getState().toggleTabViewMode(rowTabId)
      await layoutApplyTestTransport.settle()
      expect(terminalRow(rowTabId)?.viewMode).toBe('terminal')
    })

    it('setTabViewMode patches the row in the same write', async () => {
      store.getState().setTabViewMode(rowTabId, 'chat')
      await layoutApplyTestTransport.settle()
      expect(terminalRow(rowTabId)?.viewMode).toBe('chat')
    })
  })
})

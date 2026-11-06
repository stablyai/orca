import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  describe('reconcileWorktreeTabModel', () => {
    it('keeps a sole terminal renderable after its PTY exits so a failed direnv does not strand the worktree', () => {
      // Why (regression): a promoted terminal whose PTY dies must stay renderable, not orphan and bounce to Landing.
      const tab = store
        .getState()
        .createTab(WT, undefined, undefined, { pendingActivationSpawn: true })
      store.getState().updateTabPtyId(tab.id, 'pty-died')
      // First reconcile promotes the legacy runtime tab into the unified model.
      expect(store.getState().reconcileWorktreeTabModel(WT).renderableTabCount).toBe(1)

      // The newborn PTY exits: pty-connection clears the binding but keeps the pane.
      store.getState().clearTabPtyId(tab.id, 'pty-died')
      const clearedTab = store.getState().tabsByWorktree[WT]?.find((t) => t.id === tab.id)
      expect(store.getState().ptyIdsByTabId[tab.id] ?? []).toEqual([])
      expect(clearedTab?.ptyId ?? null).toBeNull()

      const result = store.getState().reconcileWorktreeTabModel(WT)
      expect(result.renderableTabCount).toBe(1)
      expect(result.activeRenderableTabId).toBe(tab.id)
    })
  })
})

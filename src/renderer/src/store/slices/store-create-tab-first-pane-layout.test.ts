import { describe, it, expect, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { replayTerminalLayout } from '@/components/terminal-pane/layout-serialization'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

describe('createTab first pane', () => {
  it('saves a plain new tab with its first pane already named, and mounts that pane', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      groupsByWorktree: {},
      activeGroupIdByWorktree: {},
      unifiedTabsByWorktree: {}
    })

    const tab = store.getState().createTab(wt)
    const saved = buildWorkspaceSessionPayload(store.getState()).terminalLayoutsByTabId[tab.id]

    const leafId = saved?.activeLeafId
    expect(leafId && isTerminalLeafId(leafId)).toBe(true)
    expect(saved?.root).toEqual({ type: 'leaf', leafId })

    const createInitialPane = vi.fn((options: { leafId?: string }) => ({
      id: 1,
      leafId: options.leafId
    }))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a single-leaf replay calls only createInitialPane.
    const manager = { createInitialPane } as unknown as PaneManager
    replayTerminalLayout(manager, saved, false)
    expect(createInitialPane).toHaveBeenCalledWith({ focus: false, leafId })
  })
})

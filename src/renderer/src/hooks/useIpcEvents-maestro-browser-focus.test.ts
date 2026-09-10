import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  createTestStore,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore
} from '@/store/slices/store-test-helpers'
import { executeMaestroWorkspaceTabCommand } from './useIpcEvents'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

globalThis.window = {
  api: {
    ui: { set: vi.fn().mockResolvedValue(undefined) },
    browser: { notifyActiveTabChanged: vi.fn().mockResolvedValue(undefined) },
    gh: {}
  }
} as never

describe('Maestro Browser focus owner', () => {
  it('activates the exact existing Browser wrapper without duplicating tabs or pages', () => {
    const store = createTestStore()
    const worktreeId = 'workspace-1'
    const maestro = makeUnifiedTab({
      id: 'maestro-tab',
      worktreeId,
      groupId: 'group-1',
      entityId: 'maestro-tab',
      contentType: 'maestro',
      label: 'Maestro',
      systemRole: 'workspace-maestro',
      isPinned: true
    })
    const group = makeTabGroup({
      id: 'group-1',
      worktreeId,
      activeTabId: maestro.id,
      tabOrder: [maestro.id]
    })
    seedStore(store, {
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      worktreesByRepo: { repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1' })] },
      groupsByWorktree: { [worktreeId]: [group] },
      unifiedTabsByWorktree: { [worktreeId]: [maestro] },
      activeGroupIdByWorktree: { [worktreeId]: group.id },
      layoutByWorktree: { [worktreeId]: { type: 'leaf', groupId: group.id } }
    } as Partial<AppState>)
    const first = store.getState().createBrowserTab(worktreeId, 'about:blank', {
      browserPageId: 'browser-page-1',
      targetGroupId: group.id,
      activate: false
    })
    const exact = store.getState().createBrowserTab(worktreeId, 'about:blank', {
      browserPageId: 'browser-page-2',
      targetGroupId: group.id,
      activate: false
    })
    const exactWrapper = store
      .getState()
      .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === exact.id)
    if (!exactWrapper) {
      throw new Error('Exact Browser wrapper was not created.')
    }
    const before = store.getState()
    const counts = {
      unified: before.unifiedTabsByWorktree[worktreeId]?.length,
      workspaces: before.browserTabsByWorktree[worktreeId]?.length,
      pages: Object.values(before.browserPagesByWorkspace).flat().length
    }

    expect(
      executeMaestroWorkspaceTabCommand(
        store.getState(),
        {
          requestId: 'focus-browser-2',
          kind: 'focus',
          worktreeId,
          tabId: exactWrapper.id
        },
        store.getState
      )
    ).toEqual({ ok: true, tabId: exactWrapper.id })

    const focused = store.getState()
    expect(focused.activeBrowserTabIdByWorktree[worktreeId]).toBe(exact.id)
    expect(focused.groupsByWorktree[worktreeId]?.[0]?.activeTabId).toBe(exactWrapper.id)
    expect(focused.activeTabTypeByWorktree[worktreeId]).toBe('browser')
    expect(focused.unifiedTabsByWorktree[worktreeId]).toHaveLength(counts.unified ?? 0)
    expect(focused.browserTabsByWorktree[worktreeId]).toHaveLength(counts.workspaces ?? 0)
    expect(Object.values(focused.browserPagesByWorkspace).flat()).toHaveLength(counts.pages)
    expect(focused.browserTabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      first.id,
      exact.id
    ])
  })
})

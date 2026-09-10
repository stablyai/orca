import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getState, flushPendingEditorChange } = vi.hoisted(() => ({
  getState: vi.fn(),
  flushPendingEditorChange: vi.fn()
}))
const useAppStore = Object.assign(vi.fn(), { getState })

vi.mock('../store', () => ({ useAppStore }))
vi.mock('@/components/editor/editor-pending-flush', () => ({ flushPendingEditorChange }))

describe('Maestro workspace tab command bridge', () => {
  beforeEach(() => {
    getState.mockReset()
    flushPendingEditorChange.mockReset()
  })

  it('acknowledges the created annotation in its original group despite a focus race', async () => {
    const maestroTab = {
      id: 'workspace-maestro-1',
      entityId: 'workspace-maestro-1',
      contentType: 'maestro',
      groupId: 'group-1',
      systemRole: 'workspace-maestro'
    }
    const exactTab = {
      id: 'annotation-tab',
      entityId: 'file-1',
      contentType: 'editor',
      groupId: 'group-1'
    }
    const latest = {
      unifiedTabsByWorktree: { 'workspace-1': [maestroTab, exactTab] },
      findTabForEntityInGroup: vi.fn(() => exactTab),
      activateTab: vi.fn()
    }
    const store = {
      activeGroupIdByWorktree: { 'workspace-1': 'group-1' },
      groupsByWorktree: {
        'workspace-1': [{ id: 'group-1', activeTabId: maestroTab.id }]
      },
      unifiedTabsByWorktree: { 'workspace-1': [maestroTab] },
      openFile: vi.fn(() => {
        store.activeGroupIdByWorktree['workspace-1'] = 'group-2'
        return 'file-1'
      })
    }
    getState.mockReturnValue(latest)
    const { executeMaestroWorkspaceTabCommand } = await import('./useIpcEvents')

    expect(
      executeMaestroWorkspaceTabCommand(store as never, {
        requestId: 'request-open-1',
        kind: 'open-annotation',
        worktreeId: 'workspace-1',
        filePath: '/workspace/.orca/maestro/note.md',
        relativePath: '.orca/maestro/note.md'
      })
    ).toEqual({ ok: true, tabId: 'annotation-tab' })
    expect(latest.findTabForEntityInGroup).toHaveBeenCalledWith(
      'workspace-1',
      'group-1',
      'file-1',
      'editor'
    )
    expect(latest.activateTab).toHaveBeenCalledWith(maestroTab.id, {
      worktreeId: 'workspace-1'
    })
  })

  it('returns only the exact dirty editor model and its content revision', async () => {
    const store = {
      unifiedTabsByWorktree: {
        'workspace-1': [{ id: 'editor-tab', entityId: 'file-1', contentType: 'editor' }]
      },
      openFiles: [{ id: 'file-1', worktreeId: 'workspace-1' }]
    }
    getState.mockReturnValue({ editorDrafts: { 'file-1': 'unsaved exact draft' } })
    const { executeMaestroWorkspaceTabCommand } = await import('./useIpcEvents')

    expect(
      executeMaestroWorkspaceTabCommand(store as never, {
        requestId: 'request-read-1',
        kind: 'read-content',
        worktreeId: 'workspace-1',
        tabId: 'editor-tab'
      })
    ).toMatchObject({ ok: true, tabId: 'editor-tab', content: 'unsaved exact draft' })
    expect(flushPendingEditorChange).toHaveBeenCalledWith('file-1')
  })

  it('renames only the exact unified workspace tab', async () => {
    const exactTab = { id: 'editor-tab', entityId: 'file-1', contentType: 'editor' }
    const store = {
      unifiedTabsByWorktree: { 'workspace-1': [exactTab] },
      setTabCustomLabel: vi.fn()
    }
    const { executeMaestroWorkspaceTabCommand } = await import('./useIpcEvents')

    expect(
      executeMaestroWorkspaceTabCommand(store as never, {
        requestId: 'request-rename-1',
        kind: 'rename',
        worktreeId: 'workspace-1',
        tabId: 'editor-tab',
        title: 'Renamed exact warning'
      })
    ).toEqual({ ok: true, tabId: 'editor-tab' })
    expect(store.setTabCustomLabel).toHaveBeenCalledWith('editor-tab', 'Renamed exact warning')
  })

  it('renames a terminal through its tab-wide title authority', async () => {
    const exactTab = { id: 'terminal-tab', entityId: 'terminal-1', contentType: 'terminal' }
    const store = {
      unifiedTabsByWorktree: { 'workspace-1': [exactTab] },
      setTabCustomTitle: vi.fn()
    }
    const { executeMaestroWorkspaceTabCommand } = await import('./useIpcEvents')

    expect(
      executeMaestroWorkspaceTabCommand(store as never, {
        requestId: 'request-rename-terminal-1',
        kind: 'rename',
        worktreeId: 'workspace-1',
        tabId: 'terminal-tab',
        title: 'Renamed terminal'
      })
    ).toEqual({ ok: true, tabId: 'terminal-tab' })
    expect(store.setTabCustomTitle).toHaveBeenCalledWith('terminal-1', 'Renamed terminal')
  })

  it('keeps the exact editor tab active when its file has another wrapper', async () => {
    let activeTabId = 'other-tab'
    const exactTab = {
      id: 'exact-tab',
      entityId: 'file-1',
      contentType: 'editor',
      groupId: 'group-1'
    }
    const store = {
      unifiedTabsByWorktree: {
        'workspace-1': [{ ...exactTab, id: 'other-tab' }, exactTab]
      },
      browserTabsByWorktree: { 'workspace-1': [] },
      setActiveWorktree: vi.fn(),
      markWorktreeVisited: vi.fn(),
      setActiveView: vi.fn(),
      setActiveFile: vi.fn(() => {
        activeTabId = 'other-tab'
      }),
      focusGroup: vi.fn(),
      activateTab: vi.fn((tabId: string) => {
        activeTabId = tabId
      }),
      setActiveTabType: vi.fn(),
      revealWorktreeInSidebar: vi.fn()
    }
    const { focusExactMobileSessionTab } = await import('./useIpcEvents')

    focusExactMobileSessionTab(store as never, 'workspace-1', 'exact-tab')

    expect(activeTabId).toBe('exact-tab')
  })

  it('selects the exact existing Browser tab without duplicating its page or wrapper', async () => {
    const browserTab = {
      id: 'browser-unified-1',
      entityId: 'browser-workspace-1',
      contentType: 'browser',
      groupId: 'group-1'
    }
    const state = {
      activeWorktreeId: 'workspace-1',
      activeTabType: 'maestro',
      activeTabTypeByWorktree: { 'workspace-1': 'maestro' },
      activeBrowserTabIdByWorktree: { 'workspace-1': null as string | null },
      browserTabsByWorktree: {
        'workspace-1': [
          {
            id: 'browser-workspace-1',
            activePageId: 'browser-page-1',
            pageIds: ['browser-page-1']
          }
        ]
      },
      browserPagesByWorkspace: {
        'browser-workspace-1': [{ id: 'browser-page-1' }]
      },
      unifiedTabsByWorktree: { 'workspace-1': [browserTab] },
      groupsByWorktree: {
        'workspace-1': [{ id: 'group-1', activeTabId: 'maestro-tab' }]
      },
      setActiveWorktree: vi.fn(),
      markWorktreeVisited: vi.fn(),
      setActiveView: vi.fn(),
      focusGroup: vi.fn(),
      activateTab: vi.fn((tabId: string) => {
        state.groupsByWorktree['workspace-1'][0]!.activeTabId = tabId
      }),
      setActiveBrowserTab: vi.fn((workspaceId: string) => {
        state.activeBrowserTabIdByWorktree['workspace-1'] = workspaceId
        state.activeTabTypeByWorktree['workspace-1'] = 'browser'
        state.activeTabType = 'browser'
      }),
      setActiveTabType: vi.fn((type: string) => {
        state.activeTabTypeByWorktree['workspace-1'] = type
        state.activeTabType = type
      }),
      revealWorktreeInSidebar: vi.fn(),
      createBrowserTab: vi.fn(),
      createBrowserPage: vi.fn()
    }
    getState.mockReturnValue(state)
    const { executeMaestroWorkspaceTabCommand } = await import('./useIpcEvents')

    expect(
      executeMaestroWorkspaceTabCommand(state as never, {
        requestId: 'focus-browser-1',
        kind: 'focus',
        worktreeId: 'workspace-1',
        tabId: browserTab.id
      })
    ).toEqual({ ok: true, tabId: browserTab.id })
    expect(state.activeBrowserTabIdByWorktree['workspace-1']).toBe(browserTab.entityId)
    expect(state.groupsByWorktree['workspace-1'][0]?.activeTabId).toBe(browserTab.id)
    expect(state.browserTabsByWorktree['workspace-1']).toHaveLength(1)
    expect(state.browserPagesByWorkspace['browser-workspace-1']).toHaveLength(1)
    expect(state.unifiedTabsByWorktree['workspace-1']).toHaveLength(1)
    expect(state.createBrowserTab).not.toHaveBeenCalled()
    expect(state.createBrowserPage).not.toHaveBeenCalled()
  })
})

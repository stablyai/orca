import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeLayout,
  makeOpenFile,
  makeTab,
  makeTabGroup,
  makeUnifiedTab,
  makeWorktree,
  seedStore,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { captureTerminalWindowTransferSeed } from './terminal-tab-window-transfer'

const kill = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  kill.mockClear()
  globalThis.window = { api: { pty: { kill } } } as never
})

function seedTerminal(store: ReturnType<typeof createTestStore>) {
  const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1', ptyId: 'pty-a', color: '#f00' })
  const unified = makeUnifiedTab({ id: tab.id, worktreeId: 'wt-1', groupId: 'group-1' })
  const group = makeTabGroup({
    id: 'group-1',
    worktreeId: 'wt-1',
    activeTabId: tab.id,
    tabOrder: [tab.id]
  })
  const layout = {
    ...makeLayout(),
    root: {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, leafId: 'leaf-1' },
      second: { type: 'leaf' as const, leafId: 'leaf-2' }
    },
    activeLeafId: 'leaf-1',
    ptyIdsByLeafId: { 'leaf-1': 'pty-a', 'leaf-2': 'pty-b' },
    buffersByLeafId: { 'leaf-1': 'buffer' },
    scrollbackRefsByLeafId: { 'leaf-1': 'scrollback-ref' }
  }
  seedStore(store, {
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: 'wt-1',
    activeWorkspaceKey: 'worktree:wt-1',
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: {
      [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })]
    },
    tabsByWorktree: { 'wt-1': [tab] },
    unifiedTabsByWorktree: { 'wt-1': [unified] },
    groupsByWorktree: { 'wt-1': [group] },
    activeGroupIdByWorktree: { 'wt-1': group.id },
    ptyIdsByTabId: { [tab.id]: ['pty-a', 'pty-b', 'pty-a'] },
    terminalLayoutsByTabId: { [tab.id]: layout }
  })
  return { tab, group, layout }
}

describe('terminal tab window transfer', () => {
  it('captures a deep terminal seed with stable unique PTY ids', () => {
    const store = createTestStore()
    const { layout } = seedTerminal(store)

    const result = captureTerminalWindowTransferSeed(store.getState(), 'tab-1')

    expect(result).toMatchObject({
      ok: true,
      seed: {
        tabId: 'tab-1',
        hostId: 'local',
        canonicalWorkspaceKey: 'worktree:wt-1',
        ptyIds: ['pty-a', 'pty-b'],
        layout: {
          buffersByLeafId: { 'leaf-1': 'buffer' },
          scrollbackRefsByLeafId: { 'leaf-1': 'scrollback-ref' }
        }
      }
    })
    layout.buffersByLeafId!['leaf-1'] = 'mutated'
    expect(result.ok && result.seed.layout.buffersByLeafId?.['leaf-1']).toBe('buffer')
  })

  it('captures rootless layout backing and strips transient activation state', () => {
    const store = createTestStore()
    const { tab } = seedTerminal(store)
    const layout = {
      root: null,
      activeLeafId: 'retained',
      expandedLeafId: null,
      ptyIdsByLeafId: { retained: 'pty-a' },
      buffersByLeafId: { retained: 'rootless-buffer' },
      scrollbackRefsByLeafId: { retained: 'rootless-ref' }
    }
    seedStore(store, {
      tabsByWorktree: { 'wt-1': [{ ...tab, pendingActivationSpawn: true }] },
      ptyIdsByTabId: { 'tab-1': ['pty-a'] },
      terminalLayoutsByTabId: { 'tab-1': layout }
    })

    const captured = captureTerminalWindowTransferSeed(store.getState(), 'tab-1')

    expect(captured).toMatchObject({
      ok: true,
      seed: { layout, ptyIds: ['pty-a'] }
    })
    expect(captured.ok && captured.seed.tab).not.toHaveProperty('pendingActivationSpawn')
  })

  it('captures an unambiguous folder workspace repo on the execution host', () => {
    const store = createTestStore()
    const folderKey = folderWorkspaceKey('folder-1')
    const repo = {
      ...TEST_REPO,
      projectGroupId: 'project-group-1',
      executionHostId: 'local' as const
    }
    const tab = makeTab({ id: 'folder-tab', worktreeId: folderKey, ptyId: 'folder-pty' })
    const group = makeTabGroup({
      id: 'folder-group',
      worktreeId: folderKey,
      activeTabId: tab.id,
      tabOrder: [tab.id]
    })
    seedStore(store, {
      repos: [repo],
      projectGroups: [
        {
          id: 'project-group-1',
          name: 'Folder group',
          parentPath: '/repo1',
          connectionId: null,
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'project-group-1',
          name: 'Folder',
          folderPath: '/repo1',
          connectionId: null,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 1,
          updatedAt: 1
        }
      ],
      activeRepoId: null,
      activeWorktreeId: folderKey,
      activeWorkspaceKey: folderKey,
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: { [folderKey]: [tab] },
      unifiedTabsByWorktree: {
        [folderKey]: [makeUnifiedTab({ id: tab.id, worktreeId: folderKey, groupId: group.id })]
      },
      groupsByWorktree: { [folderKey]: [group] },
      activeGroupIdByWorktree: { [folderKey]: group.id },
      ptyIdsByTabId: { [tab.id]: ['folder-pty'] },
      terminalLayoutsByTabId: {
        [tab.id]: {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { retained: 'folder-pty' }
        }
      }
    })

    expect(captureTerminalWindowTransferSeed(store.getState(), tab.id)).toMatchObject({
      ok: true,
      seed: {
        canonicalWorkspaceKey: folderKey,
        hostId: 'local',
        repo: { id: TEST_REPO.id }
      }
    })
  })

  it('derives an unambiguous local workspace identity when activation fields are absent', () => {
    const store = createTestStore()
    seedTerminal(store)
    seedStore(store, {
      activeRepoId: null,
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null
    })

    expect(captureTerminalWindowTransferSeed(store.getState(), 'tab-1')).toMatchObject({
      ok: true,
      seed: {
        canonicalWorkspaceKey: 'worktree:wt-1',
        hostId: 'local',
        repo: { id: TEST_REPO.id }
      }
    })
  })

  it('rejects a non-terminal or incomplete transfer without changing state', () => {
    const store = createTestStore()
    seedTerminal(store)
    const before = store.getState()

    const result = captureTerminalWindowTransferSeed(store.getState(), 'missing-tab')

    expect(result).toEqual({ ok: false, error: 'terminal_tab_not_found' })
    expect(store.getState()).toBe(before)
  })

  it('rejects a PTY ledger that disagrees with the persisted tab and layout', () => {
    const store = createTestStore()
    seedTerminal(store)
    seedStore(store, { ptyIdsByTabId: { 'tab-1': ['pty-a', 'pty-foreign'] } })
    const before = store.getState()

    expect(captureTerminalWindowTransferSeed(store.getState(), 'tab-1')).toEqual({
      ok: false,
      error: 'terminal_pty_mismatch'
    })
    expect(store.getState()).toBe(before)
  })

  it('accepts an unchanged source replay and rejects colliding target backing', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    const unchangedSource = source.getState()
    expect(source.getState().restoreTransferredTerminalTab(captured.seed)).toBe(true)
    expect(source.getState()).toBe(unchangedSource)
    const target = createTestStore()
    seedTerminal(target)
    target.setState({
      terminalLayoutsByTabId: {
        'tab-1': { ...captured.seed.layout, ptyIdsByLeafId: { 'leaf-1': 'pty-collision' } }
      }
    })
    const before = target.getState()

    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(false)
    expect(target.getState()).toBe(before)
  })

  it('imports into the existing active group without stealing its editor selection', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    const target = createTestStore()
    const editor = makeOpenFile({ id: 'file-1', worktreeId: 'wt-1' })
    const editorTab = makeUnifiedTab({
      id: editor.id,
      entityId: editor.id,
      worktreeId: 'wt-1',
      groupId: 'target-group',
      contentType: 'editor'
    })
    const targetGroup = makeTabGroup({
      id: 'target-group',
      worktreeId: 'wt-1',
      activeTabId: editor.id,
      tabOrder: [editor.id],
      recentTabIds: [editor.id]
    })
    seedStore(target, {
      activeRepoId: TEST_REPO.id,
      activeWorktreeId: 'wt-1',
      activeWorkspaceKey: 'worktree:wt-1',
      activeWorkspaceExecutionHostId: 'local',
      activeTabType: 'editor',
      activeFileId: editor.id,
      activeFileIdByWorktree: { 'wt-1': editor.id },
      activeTabTypeByWorktree: { 'wt-1': 'editor' },
      openFiles: [editor],
      unifiedTabsByWorktree: { 'wt-1': [editorTab] },
      groupsByWorktree: { 'wt-1': [targetGroup] },
      activeGroupIdByWorktree: { 'wt-1': targetGroup.id },
      layoutByWorktree: { 'wt-1': { type: 'leaf', groupId: targetGroup.id } }
    })

    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    const state = target.getState()
    expect(state.groupsByWorktree['wt-1']).toHaveLength(1)
    expect(state.groupsByWorktree['wt-1'][0]).toMatchObject({
      id: targetGroup.id,
      activeTabId: editor.id,
      tabOrder: [editor.id, 'tab-1']
    })
    expect(state.unifiedTabsByWorktree['wt-1'].find(({ id }) => id === 'tab-1')).toMatchObject({
      groupId: targetGroup.id,
      executionHostId: 'local'
    })
    expect(state.activeTabType).toBe('editor')
    expect(state.activeFileId).toBe(editor.id)
  })

  it('imports over the exact layout record staged before target readiness', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    const target = createTestStore()
    seedStore(target, {
      terminalLayoutsByTabId: { [captured.seed.tabId]: structuredClone(captured.seed.layout) }
    })

    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    expect(target.getState().tabsByWorktree['wt-1']).toEqual([captured.seed.tab])
    expect(target.getState().terminalLayoutsByTabId['tab-1']).toEqual(captured.seed.layout)
  })

  it('accepts an import replay after dynamic tab and layout presentation changes', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    const target = createTestStore()
    seedStore(target, { repos: [] })
    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    const imported = target.getState()
    target.setState({
      tabsByWorktree: {
        'wt-1': [
          {
            ...imported.tabsByWorktree['wt-1'][0],
            title: 'Live title',
            generatedTitle: 'Generated live title',
            color: '#0f0'
          }
        ]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            ...imported.unifiedTabsByWorktree['wt-1'][0],
            label: 'Live title',
            generatedLabel: 'Generated live title',
            isPreview: false,
            lastFocusedAt: 99
          }
        ]
      },
      terminalLayoutsByTabId: {
        'tab-1': {
          ...imported.terminalLayoutsByTabId['tab-1'],
          buffersByLeafId: { 'leaf-1': 'live-buffer' },
          scrollbackRefsByLeafId: { 'leaf-1': 'live-scrollback' }
        }
      },
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'pty-b' }
    })
    const beforeReplay = target.getState()

    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    expect(target.getState()).toBe(beforeReplay)

    const liveTab = target.getState().tabsByWorktree['wt-1'][0]
    target.setState({ tabsByWorktree: { 'wt-1': [{ ...liveTab, ptyId: 'foreign-pty' }] } })
    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(false)
    target.setState({
      tabsByWorktree: {
        'wt-1': [{ ...liveTab, worktreeId: 'other-worktree' }]
      }
    })
    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(false)
  })

  it('rejects an import when the target workspace has duplicate group ids', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    const target = createTestStore()
    const first = makeTabGroup({ id: 'duplicate', worktreeId: 'wt-1' })
    const second = makeTabGroup({ id: 'duplicate', worktreeId: 'wt-1' })
    seedStore(target, {
      groupsByWorktree: { 'wt-1': [first, second] },
      activeGroupIdByWorktree: { 'wt-1': 'duplicate' }
    })
    const before = target.getState()

    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(false)
    expect(target.getState()).toBe(before)
  })

  it('imports and removes a transfer idempotently without killing its PTYs', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
    const target = createTestStore()
    seedStore(target, { repos: [] })

    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    expect(target.getState().importTransferredTerminalTab(captured.seed)).toBe(true)
    expect(target.getState().tabsByWorktree['wt-1']).toEqual([captured.seed.tab])
    expect(target.getState().ptyIdsByTabId['tab-1']).toEqual(['pty-a', 'pty-b'])
    expect(target.getState().terminalLayoutsByTabId['tab-1']).toEqual(captured.seed.layout)

    expect(target.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    expect(target.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    expect(target.getState().tabsByWorktree['wt-1']).toEqual([])
    expect(kill).not.toHaveBeenCalled()
  })

  it('removes only transfer backing without invoking close or agent retirement paths', () => {
    const store = createTestStore()
    seedTerminal(store)
    const closeTab = vi.fn()
    const dropAgentStatusByTabPrefix = vi.fn()
    const clearPaneForegroundAgentByTabPrefix = vi.fn()
    store.setState({ closeTab, dropAgentStatusByTabPrefix, clearPaneForegroundAgentByTabPrefix })
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    expect(store.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    unsubscribe()

    expect(closeTab).not.toHaveBeenCalled()
    expect(dropAgentStatusByTabPrefix).not.toHaveBeenCalled()
    expect(clearPaneForegroundAgentByTabPrefix).not.toHaveBeenCalled()
    expect(subscriber).toHaveBeenCalledOnce()
    expect(kill).not.toHaveBeenCalled()
  })

  it('removes residual tab-scoped backing once and makes a repeated remove a true no-op', () => {
    const store = createTestStore()
    const paneKey = 'tab-1:leaf-1'
    seedStore(store, {
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'pty-1' },
      directSshPaneRetryByTabId: { 'tab-1': { attemptId: 'attempt-1' } as never },
      agentStatusByPaneKey: { [paneKey]: { state: 'working' } as never },
      cacheTimerByKey: { [paneKey]: 1 }
    })
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    expect(store.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    const afterFirst = store.getState()
    expect(afterFirst.lastKnownRelayPtyIdByTabId['tab-1']).toBeUndefined()
    expect(afterFirst.directSshPaneRetryByTabId['tab-1']).toBeUndefined()
    expect(afterFirst.agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(afterFirst.cacheTimerByKey[paneKey]).toBeUndefined()

    expect(store.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    unsubscribe()
    expect(store.getState()).toBe(afterFirst)
    expect(subscriber).toHaveBeenCalledOnce()
  })

  it('removes group-only terminal membership and collapses its layout leaf', () => {
    const store = createTestStore()
    const editor = makeOpenFile({ id: 'file-1', worktreeId: 'wt-1' })
    const editorGroup = makeTabGroup({
      id: 'group-2',
      worktreeId: 'wt-1',
      activeTabId: editor.id,
      tabOrder: [editor.id]
    })
    seedStore(store, {
      openFiles: [editor],
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({
            id: editor.id,
            entityId: editor.id,
            worktreeId: 'wt-1',
            groupId: editorGroup.id,
            contentType: 'editor'
          })
        ]
      },
      groupsByWorktree: {
        'wt-1': [
          makeTabGroup({
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: 'tab-1',
            tabOrder: ['tab-1']
          }),
          editorGroup
        ]
      },
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-1' },
          second: { type: 'leaf', groupId: editorGroup.id }
        }
      },
      activeWorktreeId: 'wt-1',
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      activeTabId: 'tab-1',
      activeTabIdByWorktree: { 'wt-1': 'tab-1' }
    })

    expect(store.getState().removeTransferredTerminalTab('tab-1')).toBe(true)
    const state = store.getState()
    expect(state.groupsByWorktree['wt-1']).toEqual([editorGroup])
    expect(state.layoutByWorktree['wt-1']).toEqual({ type: 'leaf', groupId: editorGroup.id })
    expect(state.activeGroupIdByWorktree['wt-1']).toBe(editorGroup.id)
    expect(state.activeTabType).toBe('editor')
    expect(state.activeFileId).toBe(editor.id)
  })

  it('collapses an emptied terminal group onto the surviving mixed-content group', () => {
    const store = createTestStore()
    const { tab } = seedTerminal(store)
    const editor = makeOpenFile({ id: 'file-1', worktreeId: 'wt-1' })
    const browser = {
      id: 'browser-1',
      worktreeId: 'wt-1',
      url: 'https://example.com',
      title: 'Example',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: 1
    }
    const surfaceGroup = makeTabGroup({
      id: 'group-2',
      worktreeId: 'wt-1',
      activeTabId: browser.id,
      tabOrder: [editor.id, browser.id],
      recentTabIds: [editor.id, browser.id]
    })
    seedStore(store, {
      openFiles: [editor],
      browserTabsByWorktree: { 'wt-1': [browser] },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({ id: tab.id, worktreeId: 'wt-1', groupId: 'group-1' }),
          makeUnifiedTab({
            id: editor.id,
            worktreeId: 'wt-1',
            groupId: surfaceGroup.id,
            contentType: 'editor'
          }),
          makeUnifiedTab({
            id: browser.id,
            worktreeId: 'wt-1',
            groupId: surfaceGroup.id,
            contentType: 'browser'
          })
        ]
      },
      groupsByWorktree: {
        'wt-1': [
          makeTabGroup({
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: tab.id,
            tabOrder: [tab.id]
          }),
          surfaceGroup
        ]
      },
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-1' },
          second: { type: 'leaf', groupId: surfaceGroup.id }
        }
      },
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      activeTabId: tab.id,
      activeTabIdByWorktree: { 'wt-1': tab.id },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-1': 'terminal' },
      recentQuickCommandIdByGroup: { 'group-1': 'quick-1', 'group-2': 'quick-2' }
    })
    const captured = captureTerminalWindowTransferSeed(store.getState(), tab.id)
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }

    expect(store.getState().removeTransferredTerminalTab(tab.id)).toBe(true)
    let state = store.getState()
    expect(state.groupsByWorktree['wt-1']).toEqual([surfaceGroup])
    expect(state.layoutByWorktree['wt-1']).toEqual({
      type: 'leaf',
      groupId: surfaceGroup.id
    })
    expect(state.activeGroupIdByWorktree['wt-1']).toBe(surfaceGroup.id)
    expect(state.activeTabType).toBe('browser')
    expect(state.activeBrowserTabId).toBe(browser.id)
    expect(state.openFiles).toEqual([editor])
    expect(state.browserTabsByWorktree['wt-1']).toEqual([browser])
    expect(state.recentQuickCommandIdByGroup).toEqual({ 'group-2': 'quick-2' })

    expect(store.getState().restoreTransferredTerminalTab(captured.seed)).toBe(true)
    state = store.getState()
    expect(state.groupsByWorktree['wt-1']).toEqual([
      surfaceGroup,
      expect.objectContaining({
        id: 'group-1',
        activeTabId: tab.id,
        tabOrder: [tab.id]
      })
    ])
    expect(state.layoutByWorktree['wt-1']).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: surfaceGroup.id },
      second: { type: 'leaf', groupId: 'group-1' }
    })
    expect(state.activeGroupIdByWorktree['wt-1']).toBe('group-1')
    expect(state.activeTabId).toBe(tab.id)
    expect(state.activeTabType).toBe('terminal')
    expect(state.openFiles).toEqual([editor])
    expect(state.browserTabsByWorktree['wt-1']).toEqual([browser])
  })

  it('clears local agent projections without retiring authority and restores the source group', () => {
    const store = createTestStore()
    const { tab, layout } = seedTerminal(store)
    const paneKey = `${tab.id}:leaf-1`
    const siblingPaneKey = 'tab-2:leaf-1'
    const agentStatusDrop = vi.fn()
    const agentStatusDropByTabPrefix = vi.fn()
    const retireAgentPaneAuthority = vi.fn()
    const transferAgentPaneAuthority = vi.fn()
    globalThis.window = {
      api: {
        pty: { kill },
        agentStatus: {
          drop: agentStatusDrop,
          dropByTabPrefix: agentStatusDropByTabPrefix,
          retirePaneAuthority: retireAgentPaneAuthority,
          transferPaneAuthority: transferAgentPaneAuthority
        }
      }
    } as never
    const editor = makeOpenFile({ id: 'file-1', worktreeId: 'wt-1' })
    const editorTab = makeUnifiedTab({
      id: editor.id,
      entityId: editor.id,
      worktreeId: 'wt-1',
      groupId: 'group-1',
      contentType: 'editor'
    })
    seedStore(store, {
      tabsByWorktree: { 'wt-1': [tab] },
      openFiles: [editor],
      unifiedTabsByWorktree: {
        'wt-1': [makeUnifiedTab({ id: tab.id, worktreeId: 'wt-1', groupId: 'group-1' }), editorTab]
      },
      groupsByWorktree: {
        'wt-1': [
          makeTabGroup({
            id: 'group-1',
            worktreeId: 'wt-1',
            activeTabId: tab.id,
            tabOrder: [tab.id, editor.id],
            recentTabIds: [editor.id, tab.id]
          })
        ]
      },
      directSshPaneRetryByTabId: { [tab.id]: { attemptId: 'attempt-1' } as never },
      directSshLivePtyBindingByTabId: { [tab.id]: { ptyId: 'pty-a' } as never },
      directSshPaneRetryHistoryByTabId: { [tab.id]: { attemptedAt: [1] } as never },
      agentStatusByPaneKey: {
        [paneKey]: { status: 'working' } as never,
        [siblingPaneKey]: { status: 'working' } as never
      },
      runtimeAgentOrchestrationByPaneKey: {
        [paneKey]: { dispatchStatus: 'running' } as never,
        [siblingPaneKey]: { dispatchStatus: 'running' } as never
      },
      retainedAgentsByPaneKey: {
        [paneKey]: { worktreeId: 'wt-1' } as never,
        [siblingPaneKey]: { worktreeId: 'wt-1' } as never
      },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: { worktreeId: 'wt-1' } as never,
        [siblingPaneKey]: { worktreeId: 'wt-1' } as never
      },
      agentLaunchConfigByPaneKey: {
        [paneKey]: { registeredAt: 1 } as never,
        [siblingPaneKey]: { registeredAt: 1 } as never
      },
      acknowledgedAgentsByPaneKey: { [paneKey]: 1, [siblingPaneKey]: 1 },
      retentionSuppressedPaneKeys: { [paneKey]: true, [siblingPaneKey]: true },
      recentlyRetiredAgentStatusPaneKeys: { [paneKey]: true, [siblingPaneKey]: true },
      recentlyClosedAgentStatusTabIds: { [tab.id]: true, 'tab-2': true },
      migrationUnsupportedByPtyId: {
        'pty-a': { paneKey } as never,
        'pty-sibling': { paneKey: siblingPaneKey } as never
      },
      paneForegroundAgentByPaneKey: {
        [paneKey]: { agent: 'claude', shellForeground: false },
        [siblingPaneKey]: { agent: 'claude', shellForeground: false }
      },
      unreadTerminalPanes: { [paneKey]: true, [siblingPaneKey]: true },
      unreadAgentCompletionPanes: { [paneKey]: true, [siblingPaneKey]: true },
      lastTerminalInputAtByPaneKey: { [paneKey]: 1, [siblingPaneKey]: 1 },
      cacheTimerByKey: { [paneKey]: 1, [siblingPaneKey]: 1 },
      terminalLayoutsByTabId: { [tab.id]: layout }
    })
    const { agentStatusEpoch, sortEpoch } = store.getState()
    const captured = captureTerminalWindowTransferSeed(store.getState(), tab.id)
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }

    expect(store.getState().removeTransferredTerminalTab(tab.id)).toBe(true)
    let state = store.getState()
    expect(state.directSshPaneRetryByTabId[tab.id]).toBeUndefined()
    expect(state.directSshLivePtyBindingByTabId[tab.id]).toBeUndefined()
    expect(state.directSshPaneRetryHistoryByTabId[tab.id]).toBeUndefined()
    for (const projection of [
      state.agentStatusByPaneKey,
      state.runtimeAgentOrchestrationByPaneKey,
      state.retainedAgentsByPaneKey,
      state.sleepingAgentSessionsByPaneKey,
      state.agentLaunchConfigByPaneKey,
      state.acknowledgedAgentsByPaneKey,
      state.retentionSuppressedPaneKeys,
      state.recentlyRetiredAgentStatusPaneKeys,
      state.paneForegroundAgentByPaneKey,
      state.unreadTerminalPanes,
      state.unreadAgentCompletionPanes,
      state.lastTerminalInputAtByPaneKey,
      state.cacheTimerByKey
    ]) {
      expect(projection[paneKey]).toBeUndefined()
      expect(projection[siblingPaneKey]).toBeDefined()
    }
    expect(state.recentlyClosedAgentStatusTabIds[tab.id]).toBeUndefined()
    expect(state.recentlyClosedAgentStatusTabIds['tab-2']).toBe(true)
    expect(state.migrationUnsupportedByPtyId['pty-a']).toBeUndefined()
    expect(state.migrationUnsupportedByPtyId['pty-sibling']).toBeDefined()
    expect(state.agentStatusEpoch).toBe(agentStatusEpoch + 1)
    expect(state.sortEpoch).toBe(sortEpoch + 1)
    expect(state.groupsByWorktree['wt-1'][0]).toMatchObject({
      activeTabId: editor.id,
      tabOrder: [editor.id]
    })
    expect(state.activeTabTypeByWorktree['wt-1']).toBe('editor')
    expect(state.activeFileIdByWorktree['wt-1']).toBe(editor.id)

    expect(store.getState().restoreTransferredTerminalTab(captured.seed)).toBe(true)
    state = store.getState()
    expect(state.groupsByWorktree['wt-1'][0]).toMatchObject({
      activeTabId: tab.id,
      tabOrder: [tab.id, editor.id],
      recentTabIds: [editor.id, tab.id]
    })
    expect(state.activeTabId).toBe(tab.id)
    expect(state.activeTabTypeByWorktree['wt-1']).toBe('terminal')
    expect(state.terminalLayoutsByTabId[tab.id]).toEqual(layout)
    expect(state.directSshPaneRetryByTabId[tab.id]).toBeUndefined()
    expect(agentStatusDrop).not.toHaveBeenCalled()
    expect(agentStatusDropByTabPrefix).not.toHaveBeenCalled()
    expect(retireAgentPaneAuthority).not.toHaveBeenCalled()
    expect(transferAgentPaneAuthority).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  })
})

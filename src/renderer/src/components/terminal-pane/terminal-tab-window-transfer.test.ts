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

  it('rejects colliding target backing without mutating it', () => {
    const source = createTestStore()
    seedTerminal(source)
    const captured = captureTerminalWindowTransferSeed(source.getState(), 'tab-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) {
      return
    }
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

  it('clears renderer SSH leases, preserves agent authority, and restores the source group', () => {
    const store = createTestStore()
    const { tab, layout } = seedTerminal(store)
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
      agentStatusByPaneKey: { [`${tab.id}:leaf-1`]: { status: 'working' } as never },
      paneForegroundAgentByPaneKey: {
        [`${tab.id}:leaf-1`]: { agent: 'claude', shellForeground: false }
      },
      terminalLayoutsByTabId: { [tab.id]: layout }
    })
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
    expect(state.agentStatusByPaneKey[`${tab.id}:leaf-1`]).toBeDefined()
    expect(state.paneForegroundAgentByPaneKey[`${tab.id}:leaf-1`]).toBeDefined()
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
    expect(kill).not.toHaveBeenCalled()
  })
})

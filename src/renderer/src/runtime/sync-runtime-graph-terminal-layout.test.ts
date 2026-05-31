/* eslint-disable max-lines -- Why: this file keeps terminal session publication
 * fixtures together so split-pane and split-tab parity assertions do not drift. */
import { describe, expect, it } from 'vitest'
import { buildMobileSessionTabSnapshots } from './sync-runtime-graph'
import type { AppState } from '../store/types'

function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {} as AppState['terminalLayoutsByTabId'],
    runtimePaneTitlesByTabId: {} as AppState['runtimePaneTitlesByTabId'],
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    ...overrides
  } as AppState
}

describe('terminal mobile session layout publication', () => {
  it('publishes large tab groups without using argument-list spreads', () => {
    const tabCount = 130_000
    const openFiles = Array.from({ length: tabCount }, (_, index) => ({
      id: `/repo/file-${index}.ts`,
      filePath: `/repo/file-${index}.ts`,
      relativePath: `file-${index}.ts`,
      worktreeId: 'wt-1',
      language: 'typescript',
      mode: 'edit',
      isDirty: false
    }))
    const unifiedTabs = openFiles.map((file, index) => ({
      id: `editor-tab-${index}`,
      groupId: 'group-1',
      contentType: 'editor',
      entityId: file.id,
      title: `file-${index}.ts`
    }))
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      activeFileIdByWorktree: { 'wt-1': openFiles[0].id },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: unifiedTabs[0].id,
            tabOrder: unifiedTabs.map((tab) => tab.id)
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': unifiedTabs
      } as unknown as AppState['unifiedTabsByWorktree'],
      openFiles: openFiles as AppState['openFiles']
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs).toHaveLength(tabCount)
    expect(snapshot?.tabs[0]?.id).toBe('editor-tab-0')
    expect(snapshot?.tabs.at(-1)?.id).toBe(`editor-tab-${tabCount - 1}`)
  })

  it('publishes terminal parent layout so remote clients can keep split panes grouped', () => {
    const firstLeaf = '11111111-1111-4111-8111-111111111111'
    const secondLeaf = '22222222-2222-4222-8222-222222222222'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'unified-term-1',
            tabOrder: ['unified-term-1']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-term-1',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'term-1',
            title: 'Terminal'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-1',
            worktreeId: 'wt-1',
            ptyId: 'pty-1',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: firstLeaf },
            second: { type: 'leaf', leafId: secondLeaf }
          },
          activeLeafId: secondLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [firstLeaf]: 'pty-left',
            [secondLeaf]: 'pty-right'
          }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'terminal',
        parentTabId: 'term-1',
        leafId: firstLeaf,
        ptyId: 'pty-left',
        parentLayout: {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: firstLeaf },
            second: { type: 'leaf', leafId: secondLeaf }
          },
          activeLeafId: secondLeaf,
          ptyIdsByLeafId: {
            [firstLeaf]: 'pty-left',
            [secondLeaf]: 'pty-right'
          }
        },
        isActive: false
      },
      {
        type: 'terminal',
        parentTabId: 'term-1',
        leafId: secondLeaf,
        ptyId: 'pty-right',
        parentLayout: {
          activeLeafId: secondLeaf,
          ptyIdsByLeafId: {
            [firstLeaf]: 'pty-left',
            [secondLeaf]: 'pty-right'
          }
        },
        isActive: true
      }
    ])
  })

  it('publishes split tab groups so remote clients mirror terminal tab splits', () => {
    const leftLeaf = '11111111-1111-4111-8111-111111111111'
    const rightLeaf = '22222222-2222-4222-8222-222222222222'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-right' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'term-left',
            tabOrder: ['term-left']
          },
          {
            id: 'group-right',
            activeTabId: 'term-right',
            tabOrder: ['term-right']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      layoutByWorktree: {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-left' },
          second: { type: 'leaf', groupId: 'group-right' }
        }
      } as unknown as AppState['layoutByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'term-left',
            groupId: 'group-left',
            contentType: 'terminal',
            entityId: 'term-left',
            title: 'Left'
          },
          {
            id: 'term-right',
            groupId: 'group-right',
            contentType: 'terminal',
            entityId: 'term-right',
            title: 'Right'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-left',
            worktreeId: 'wt-1',
            ptyId: 'pty-left',
            title: 'Left',
            defaultTitle: 'Left',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'term-right',
            worktreeId: 'wt-1',
            ptyId: 'pty-right',
            title: 'Right',
            defaultTitle: 'Right',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-left': {
          root: { type: 'leaf', leafId: leftLeaf },
          activeLeafId: leftLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leftLeaf]: 'pty-left' }
        },
        'term-right': {
          root: { type: 'leaf', leafId: rightLeaf },
          activeLeafId: rightLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [rightLeaf]: 'pty-right' }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.tabs.map((tab) => tab.id)).toEqual([
      `term-left::${leftLeaf}`,
      `term-right::${rightLeaf}`
    ])
    expect(snapshot?.tabGroups).toEqual([
      { id: 'group-left', activeTabId: 'term-left', tabOrder: ['term-left'], recentTabIds: [] },
      { id: 'group-right', activeTabId: 'term-right', tabOrder: ['term-right'], recentTabIds: [] }
    ])
    expect(snapshot?.tabGroupLayout).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    })
  })

  it('publishes the active tab from the active split group', () => {
    const rightLeaf = '22222222-2222-4222-8222-222222222222'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-right' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-left',
            activeTabId: 'browser-left',
            tabOrder: ['browser-left']
          },
          {
            id: 'group-right',
            activeTabId: 'term-right',
            tabOrder: ['term-right']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-left',
            groupId: 'group-left',
            contentType: 'browser',
            entityId: 'browser-1',
            title: 'Browser'
          },
          {
            id: 'term-right',
            groupId: 'group-right',
            contentType: 'terminal',
            entityId: 'term-right',
            title: 'Terminal'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-right',
            worktreeId: 'wt-1',
            ptyId: 'pty-right',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-right': {
          root: { type: 'leaf', leafId: rightLeaf },
          activeLeafId: rightLeaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [rightLeaf]: 'pty-right' }
        }
      } as unknown as AppState['terminalLayoutsByTabId'],
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'browser-1',
            worktreeId: 'wt-1',
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.test',
            title: 'Browser',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as unknown as AppState['browserTabsByWorktree'],
      browserPagesByWorkspace: {
        'browser-1': [
          {
            id: 'page-1',
            workspaceId: 'browser-1',
            worktreeId: 'wt-1',
            url: 'https://example.test',
            title: 'Browser',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      } as unknown as AppState['browserPagesByWorkspace']
    })

    const snapshot = buildMobileSessionTabSnapshots(state)[0]

    expect(snapshot?.activeTabId).toBe(`term-right::${rightLeaf}`)
    expect(snapshot?.tabs.find((tab) => tab.id === 'browser-left')).toMatchObject({
      isActive: false
    })
  })

  it('does not publish web-mirrored terminal tabs back to the host session', () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'web-unified-term-1',
            tabOrder: ['web-unified-term-1']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'web-unified-term-1',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'web-terminal-host-tab-1',
            title: 'Terminal'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'web-terminal-host-tab-1',
            worktreeId: 'wt-1',
            ptyId: 'remote:env-1@@terminal-1',
            title: 'Terminal',
            defaultTitle: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'web-terminal-host-tab-1': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [leaf]: 'remote:env-1@@terminal-1'
          }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toEqual([])
  })

  it('publishes legacy web-prefixed host terminal tabs when they own local PTYs', () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'web-terminal-local-host-tab',
            tabOrder: ['web-terminal-local-host-tab']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'web-terminal-local-host-tab',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'web-terminal-local-host-tab',
            title: 'Terminal 5'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'web-terminal-local-host-tab',
            worktreeId: 'wt-1',
            ptyId: 'wt-1@@local-pty-1',
            title: 'Terminal 5',
            defaultTitle: 'Terminal 5',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'web-terminal-local-host-tab': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [leaf]: 'wt-1@@local-pty-1'
          }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs).toMatchObject([
      {
        type: 'terminal',
        id: `web-terminal-local-host-tab::${leaf}`,
        parentTabId: 'web-terminal-local-host-tab',
        ptyId: 'wt-1@@local-pty-1',
        title: 'Terminal 5',
        isActive: true
      }
    ])
  })

  it('does not publish stale single-pane tab labels as pane titles', () => {
    const leaf = '11111111-1111-4111-8111-111111111111'
    const state = makeState({
      activeGroupIdByWorktree: { 'wt-1': 'group-1' },
      groupsByWorktree: {
        'wt-1': [
          {
            id: 'group-1',
            activeTabId: 'unified-term-1',
            tabOrder: ['unified-term-1']
          }
        ]
      } as unknown as AppState['groupsByWorktree'],
      unifiedTabsByWorktree: {
        'wt-1': [
          {
            id: 'unified-term-1',
            groupId: 'group-1',
            contentType: 'terminal',
            entityId: 'term-1',
            title: 'Nightly audit'
          }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'term-1',
            worktreeId: 'wt-1',
            ptyId: 'pty-1',
            title: 'Terminal 1',
            defaultTitle: 'Terminal 1',
            customTitle: 'Nightly audit',
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      } as unknown as AppState['tabsByWorktree'],
      terminalLayoutsByTabId: {
        'term-1': {
          root: { type: 'leaf', leafId: leaf },
          activeLeafId: leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leaf]: 'pty-1' },
          titlesByLeafId: { [leaf]: 'Nightly audit' }
        }
      } as unknown as AppState['terminalLayoutsByTabId']
    })

    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs[0]).toMatchObject({
      type: 'terminal',
      title: 'Nightly audit',
      parentLayout: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        ptyIdsByLeafId: { [leaf]: 'pty-1' }
      }
    })
    expect(buildMobileSessionTabSnapshots(state)[0]?.tabs[0]).not.toHaveProperty(
      'parentLayout.titlesByLeafId'
    )
  })
})

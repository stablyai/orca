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
})

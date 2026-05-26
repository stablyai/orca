/* eslint-disable max-lines -- Why: these tests cover one reconciliation boundary
 * across ready, pending, split, and batched session snapshots. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { BrowserPage, BrowserWorkspace, Tab, TerminalTab } from '../../../shared/types'
import type { OpenFile } from '../store/slices/editor'
import {
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshots,
  resolveHostSessionTabIdForWebSessionTab,
  resetWebSessionTabsSnapshotFreshnessForTests,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

const WT = 'repo::/worktree'
const ENV = 'web-env-1'
const NOW = 1_700_000_000_000
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const HOST_SURFACE_ID = `host-tab-1::${LEAF_ID}`

function makeState(overrides: Partial<WebSessionTabsSyncState> = {}): WebSessionTabsSyncState {
  return {
    activeBrowserTabId: null,
    activeBrowserTabIdByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeGroupIdByWorktree: {},
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeWorktreeId: WT,
    agentStatusByPaneKey: {},
    agentStatusEpoch: 0,
    browserPagesByWorkspace: {},
    browserTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    openFiles: [],
    ptyIdsByTabId: {},
    remoteBrowserPageHandlesByPageId: {},
    tabBarOrderByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabsByWorktree: {},
    unreadTerminalTabs: {},
    sortEpoch: 0,
    ...overrides
  }
}

function makeSnapshot(
  tabs: RuntimeMobileSessionTabsResult['tabs'],
  overrides: Partial<RuntimeMobileSessionTabsResult> = {}
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WT,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'host-group-1',
    activeTabId: tabs.find((tab) => tab.type === 'terminal' && tab.isActive)?.id ?? null,
    activeTabType: 'terminal',
    tabs,
    ...overrides
  }
}

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(() => {
    resetWebSessionTabsSnapshotFreshnessForTests()
  })

  it('ignores stale or duplicate same-epoch snapshots after a newer version was applied', () => {
    const state = makeState()
    const newer = makeSnapshot([], { snapshotVersion: 3, activeTabType: null })
    const older = makeSnapshot([], { snapshotVersion: 2, activeTabType: null })

    const first = applyFreshWebSessionTabsSnapshot(state, newer, ENV, NOW)
    const afterNewer = { ...state, ...(first as Partial<WebSessionTabsSyncState>) }
    const second = applyFreshWebSessionTabsSnapshot(afterNewer, older, ENV, NOW)

    expect(second).toBe(afterNewer)
    expect(applyFreshWebSessionTabsSnapshot(afterNewer, newer, ENV, NOW)).toBe(afterNewer)
  })

  it('hydrates ready host terminal surfaces as remote runtime terminal tabs', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).toBeTruthy()
    expect(mirroredId).not.toContain(':')
    expect(() => makePaneKey(mirroredId!, LEAF_ID)).not.toThrow()
    expect(patch.tabsByWorktree?.[WT]).toMatchObject([
      {
        id: mirroredId,
        ptyId: 'remote:web-env-1@@terminal-1',
        title: 'host shell',
        worktreeId: WT
      }
    ])
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toEqual(['remote:web-env-1@@terminal-1'])
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      ptyIdsByLeafId: { [LEAF_ID]: 'remote:web-env-1@@terminal-1' }
    })
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]?.titlesByLeafId).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      id: 'host-group-1',
      activeTabId: mirroredId,
      tabOrder: [mirroredId]
    })
    expect(patch.activeTabId).toBe(mirroredId)
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(mirroredId)
  })

  it('hydrates host split tab groups with mirrored terminal tab ids', () => {
    const rightLeafId = SECOND_LEAF_ID
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-left::${LEAF_ID}`,
            title: 'left shell',
            parentTabId: 'host-left',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-left'
          },
          {
            type: 'terminal',
            id: `host-right::${rightLeafId}`,
            title: 'right shell',
            parentTabId: 'host-right',
            leafId: rightLeafId,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-right'
          }
        ],
        {
          activeGroupId: 'group-right',
          activeTabId: `host-right::${rightLeafId}`,
          tabGroups: [
            { id: 'group-left', activeTabId: 'host-left', tabOrder: ['host-left'] },
            { id: 'group-right', activeTabId: 'host-right', tabOrder: ['host-right'] }
          ],
          tabGroupLayout: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-left' },
            second: { type: 'leaf', groupId: 'group-right' }
          }
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const leftId = patch.tabsByWorktree?.[WT]?.find((tab) => tab.title === 'left shell')?.id
    const rightId = patch.tabsByWorktree?.[WT]?.find((tab) => tab.title === 'right shell')?.id

    expect(leftId).toBeTruthy()
    expect(rightId).toBeTruthy()
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: leftId, groupId: 'group-left' }),
        expect.objectContaining({ id: rightId, groupId: 'group-right' })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]).toEqual([
      {
        id: 'group-left',
        worktreeId: WT,
        activeTabId: leftId,
        tabOrder: [leftId],
        recentTabIds: [leftId]
      },
      {
        id: 'group-right',
        worktreeId: WT,
        activeTabId: rightId,
        tabOrder: [rightId],
        recentTabIds: [rightId]
      }
    ])
    expect(patch.layoutByWorktree?.[WT]).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', groupId: 'group-left' },
      second: { type: 'leaf', groupId: 'group-right' }
    })
    expect(patch.activeGroupIdByWorktree?.[WT]).toBe('group-right')
  })

  it('assigns mirrored terminal, browser, and editor tabs to their host split groups', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-terminal::${LEAF_ID}`,
            title: 'host shell',
            parentTabId: 'host-terminal',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: false
          },
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        {
          activeGroupId: 'group-editor',
          activeTabId: 'host-readme-unified',
          activeTabType: 'markdown',
          tabGroups: [
            { id: 'group-terminal', activeTabId: 'host-terminal', tabOrder: ['host-terminal'] },
            {
              id: 'group-browser',
              activeTabId: 'host-browser-unified',
              tabOrder: ['host-browser-unified']
            },
            {
              id: 'group-editor',
              activeTabId: 'host-readme-unified',
              tabOrder: ['host-readme-unified']
            }
          ],
          tabGroupLayout: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: 'group-terminal' },
            second: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', groupId: 'group-browser' },
              second: { type: 'leaf', groupId: 'group-editor' }
            }
          }
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const unifiedTabs = patch.unifiedTabsByWorktree?.[WT] ?? []
    const terminalTab = unifiedTabs.find((tab) => tab.contentType === 'terminal')
    const browserTab = unifiedTabs.find((tab) => tab.contentType === 'browser')
    const editorTab = unifiedTabs.find((tab) => tab.contentType === 'editor')

    expect(terminalTab).toMatchObject({ groupId: 'group-terminal' })
    expect(browserTab).toMatchObject({ id: 'host-browser-unified', groupId: 'group-browser' })
    expect(editorTab).toMatchObject({ id: 'host-readme-unified', groupId: 'group-editor' })
  })

  it('keeps retained local-only groups reachable when applying a host layout', () => {
    const localTab: Tab = {
      id: 'local-editor-tab',
      entityId: 'local-editor-file',
      groupId: 'local-group',
      worktreeId: WT,
      contentType: 'editor',
      label: 'notes.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    const currentLayout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'host-group-1' },
      second: { type: 'leaf' as const, groupId: 'local-group' }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        unifiedTabsByWorktree: { [WT]: [localTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            },
            {
              id: 'local-group',
              worktreeId: WT,
              activeTabId: localTab.id,
              tabOrder: [localTab.id],
              recentTabIds: [localTab.id]
            }
          ]
        },
        layoutByWorktree: { [WT]: currentLayout }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-terminal::${LEAF_ID}`,
            title: 'host shell',
            parentTabId: 'host-terminal',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ],
        {
          activeGroupId: 'host-group-1',
          activeTabId: `host-terminal::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [
            { id: 'host-group-1', activeTabId: 'host-terminal', tabOrder: ['host-terminal'] }
          ],
          tabGroupLayout: { type: 'leaf', groupId: 'host-group-1' }
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.groupsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-group',
          tabOrder: [localTab.id]
        })
      ])
    )
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('keeps retained local-only groups reachable when host omits layout', () => {
    const localTab: Tab = {
      id: 'local-editor-tab',
      entityId: 'local-editor-file',
      groupId: 'local-group',
      worktreeId: WT,
      contentType: 'editor',
      label: 'notes.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    const currentLayout = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, groupId: 'host-group-1' },
      second: { type: 'leaf' as const, groupId: 'local-group' }
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        unifiedTabsByWorktree: { [WT]: [localTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            },
            {
              id: 'local-group',
              worktreeId: WT,
              activeTabId: localTab.id,
              tabOrder: [localTab.id],
              recentTabIds: [localTab.id]
            }
          ]
        },
        layoutByWorktree: { [WT]: currentLayout }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-terminal::${LEAF_ID}`,
            title: 'host shell',
            parentTabId: 'host-terminal',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ],
        {
          activeGroupId: 'host-group-1',
          activeTabId: `host-terminal::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [
            { id: 'host-group-1', activeTabId: 'host-terminal', tabOrder: ['host-terminal'] }
          ]
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.groupsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'local-group',
          tabOrder: [localTab.id]
        })
      ])
    )
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('preserves host pane titles without synthesizing them from tab titles', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Terminal 2',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            titlesByLeafId: { [LEAF_ID]: 'user title' }
          },
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.tabsByWorktree?.[WT]?.[0]?.title).toBe('Terminal 2')
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]?.titlesByLeafId).toEqual({
      [LEAF_ID]: 'user title'
    })
  })

  it('drops stale single-pane parent titles that duplicate the host tab title', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Terminal 2',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            titlesByLeafId: { [LEAF_ID]: 'Terminal 2' }
          },
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]?.titlesByLeafId).toBeUndefined()
  })

  it('remaps host agent status onto mirrored terminal pane keys', () => {
    const hostPaneKey = makePaneKey('host-tab-1', LEAF_ID)
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'codex [working]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'fix web parity',
            updatedAt: NOW - 100,
            stateStartedAt: NOW - 1_000,
            agentType: 'codex',
            paneKey: hostPaneKey,
            terminalTitle: 'codex [working]',
            stateHistory: []
          }
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    const mirroredPaneKey = makePaneKey(mirroredId!, LEAF_ID)
    expect(patch.agentStatusByPaneKey?.[mirroredPaneKey]).toMatchObject({
      state: 'working',
      prompt: 'fix web parity',
      agentType: 'codex',
      paneKey: mirroredPaneKey,
      terminalTitle: 'codex [working]'
    })
    expect(patch.agentStatusByPaneKey?.[hostPaneKey]).toBeUndefined()
    expect(patch.agentStatusEpoch).toBe(1)
    expect(patch.sortEpoch).toBe(1)
  })

  it('hydrates multiple initial host snapshots in one merged patch', () => {
    const secondWorktree = 'repo::/other-worktree'
    const patch = applyWebSessionTabsSnapshots(
      makeState({ activeWorktreeId: null }),
      [
        makeSnapshot([
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          }
        ]),
        makeSnapshot(
          [
            {
              type: 'terminal',
              id: `host-tab-2::${SECOND_LEAF_ID}`,
              title: 'second shell',
              parentTabId: 'host-tab-2',
              leafId: SECOND_LEAF_ID,
              isActive: true,
              status: 'ready',
              terminal: 'terminal-2'
            }
          ],
          { worktree: secondWorktree, activeGroupId: 'host-group-2' }
        )
      ],
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.tabsByWorktree?.[secondWorktree]).toHaveLength(1)
    expect(patch.ptyIdsByTabId).toEqual(
      expect.objectContaining({
        [patch.tabsByWorktree?.[WT]?.[0]?.id ?? '']: ['remote:web-env-1@@terminal-1'],
        [patch.tabsByWorktree?.[secondWorktree]?.[0]?.id ?? '']: ['remote:web-env-1@@terminal-2']
      })
    )
  })

  it('replaces temporary web-created tabs once the host publishes the same PTY', () => {
    const localTab: TerminalTab = {
      id: 'local-web-tab',
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'local shell',
      defaultTitle: 'local shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 1
    }
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [localTab] },
        ptyIdsByTabId: { 'local-web-tab': ['remote:web-env-1@@terminal-1'] },
        terminalLayoutsByTabId: {
          'local-web-tab': { root: null, activeLeafId: null, expandedLeafId: null }
        },
        unreadTerminalTabs: { 'local-web-tab': true }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual([
      expect.not.stringContaining(':')
    ])
    expect(patch.ptyIdsByTabId?.['local-web-tab']).toBeUndefined()
    expect(patch.unreadTerminalTabs?.['local-web-tab']).toBeUndefined()
  })

  it('groups split host terminal panes under one web tab', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'left pane',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            expandedLeafId: null
          },
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'right pane',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          parentLayout: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: SECOND_LEAF_ID,
            expandedLeafId: null
          },
          isActive: true,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.tabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-2',
      title: 'right pane'
    })
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toEqual([
      'remote:web-env-1@@terminal-1',
      'remote:web-env-1@@terminal-2'
    ])
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_ID },
        second: { type: 'leaf', leafId: SECOND_LEAF_ID }
      },
      activeLeafId: SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1',
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-2'
      }
    })
    expect(patch.groupsByWorktree?.[WT]?.[0]?.tabOrder).toEqual([mirroredId])
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(mirroredId)
  })

  it('removes a null-pty pending activation tab when the host publishes the initial terminal', () => {
    const pendingTab: TerminalTab = {
      id: 'local-pending-tab',
      ptyId: null,
      worktreeId: WT,
      title: 'Terminal 1',
      defaultTitle: 'Terminal 1',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 1,
      pendingActivationSpawn: true
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [pendingTab] },
        activeTabId: pendingTab.id,
        activeTabIdByWorktree: { [WT]: pendingTab.id }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'host shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.map((tab) => tab.id)).not.toContain(pendingTab.id)
    expect(patch.activeTabIdByWorktree?.[WT]).not.toBe(pendingTab.id)
  })

  it('hydrates active host browser tabs with remote page handles', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: true,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const terminalId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.browserTabsByWorktree?.[WT]).toMatchObject([
      {
        id: 'host-browser-workspace',
        worktreeId: WT,
        activePageId: 'host-browser-page',
        pageIds: ['host-browser-page'],
        url: 'https://example.com/',
        title: 'Example Domain',
        canGoBack: true,
        canGoForward: false
      }
    ])
    expect(patch.browserPagesByWorkspace?.['host-browser-workspace']).toMatchObject([
      {
        id: 'host-browser-page',
        workspaceId: 'host-browser-workspace',
        worktreeId: WT,
        url: 'https://example.com/',
        title: 'Example Domain',
        loading: false
      }
    ])
    expect(patch.remoteBrowserPageHandlesByPageId?.['host-browser-page']).toEqual({
      environmentId: ENV,
      remotePageId: 'host-browser-page'
    })
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: terminalId,
          entityId: terminalId,
          contentType: 'terminal'
        }),
        expect.objectContaining({
          id: 'host-browser-unified',
          entityId: 'host-browser-workspace',
          contentType: 'browser',
          label: 'Example Domain'
        })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      id: 'host-group-1',
      activeTabId: 'host-browser-unified',
      tabOrder: [terminalId, 'host-browser-unified']
    })
    expect(patch.activeBrowserTabId).toBe('host-browser-workspace')
    expect(patch.activeBrowserTabIdByWorktree?.[WT]).toBe('host-browser-workspace')
    expect(patch.activeTabId).toBe(terminalId)
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(terminalId)
    expect(patch.activeTabType).toBe('browser')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('browser')
  })

  it('keeps mirrored browser tabs in a rendered web layout group', () => {
    const visibleGroupId = 'visible-web-group'
    const hostOnlyGroupId = 'host-group-1'
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeGroupIdByWorktree: { [WT]: hostOnlyGroupId },
        groupsByWorktree: {
          [WT]: [
            {
              id: visibleGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            },
            {
              id: hostOnlyGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: visibleGroupId } }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const browserUnifiedTab = patch.unifiedTabsByWorktree?.[WT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserUnifiedTab).toMatchObject({ groupId: visibleGroupId })
    expect(
      patch.groupsByWorktree?.[WT]?.find((group) => group.id === visibleGroupId)
    ).toMatchObject({
      activeTabId: 'host-browser-unified',
      tabOrder: ['host-browser-unified']
    })
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('creates a rendered web layout group when stale group records do not include it', () => {
    const visibleGroupId = 'visible-web-group'
    const hostOnlyGroupId = 'host-group-1'
    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeGroupIdByWorktree: { [WT]: hostOnlyGroupId },
        groupsByWorktree: {
          [WT]: [
            {
              id: hostOnlyGroupId,
              worktreeId: WT,
              activeTabId: null,
              tabOrder: []
            }
          ]
        },
        layoutByWorktree: { [WT]: { type: 'leaf', groupId: visibleGroupId } }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const browserUnifiedTab = patch.unifiedTabsByWorktree?.[WT]?.find(
      (tab) => tab.contentType === 'browser'
    )
    expect(browserUnifiedTab).toMatchObject({ groupId: visibleGroupId })
    expect(patch.groupsByWorktree?.[WT]).toEqual([
      expect.objectContaining({
        id: visibleGroupId,
        activeTabId: 'host-browser-unified',
        tabOrder: ['host-browser-unified']
      })
    ])
    expect(patch.activeGroupIdByWorktree?.[WT]).toBe(visibleGroupId)
    expect(patch.layoutByWorktree).toBeUndefined()
  })

  it('reuses a local browser workspace that already points at the host page', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'about:blank',
      title: 'New Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: 'about:blank',
      title: 'New Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const unifiedTab: Tab = {
      id: 'local-browser-unified',
      entityId: workspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: 'New Tab',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'browser',
            id: 'host-browser-unified',
            title: 'Example Domain',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'https://example.com/',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser-unified', activeTabType: 'browser' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.browserTabsByWorktree?.[WT]).toHaveLength(1)
    expect(patch.browserTabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: workspace.id,
      activePageId: page.id,
      url: 'https://example.com/',
      title: 'Example Domain'
    })
    expect(patch.browserPagesByWorkspace?.[workspace.id]).toMatchObject([
      {
        id: page.id,
        workspaceId: workspace.id,
        url: 'https://example.com/',
        title: 'Example Domain'
      }
    ])
    expect(patch.remoteBrowserPageHandlesByPageId?.[page.id]).toEqual({
      environmentId: ENV,
      remotePageId: 'host-browser-page'
    })
    expect(patch.unifiedTabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual([
      'local-browser-unified'
    ])
    expect(
      resolveHostSessionTabIdForWebSessionTab(makeState(), {
        environmentId: ENV,
        worktreeId: WT,
        tabId: 'local-browser-unified'
      })
    ).toBe('host-browser-unified')
  })

  it('removes mirrored browser tabs when the host closes the page', () => {
    const workspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'https://example.com/',
      title: 'Example Domain',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW - 10
    }
    const page: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: workspace.id,
      worktreeId: WT,
      url: workspace.url,
      title: workspace.title,
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: workspace.createdAt
    }
    const unifiedTab: Tab = {
      id: 'local-browser-unified',
      entityId: workspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: workspace.title,
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: workspace.createdAt,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeBrowserTabId: workspace.id,
        activeBrowserTabIdByWorktree: { [WT]: workspace.id },
        activeTabType: 'browser',
        activeTabTypeByWorktree: { [WT]: 'browser' },
        browserTabsByWorktree: { [WT]: [workspace] },
        browserPagesByWorkspace: { [workspace.id]: [page] },
        remoteBrowserPageHandlesByPageId: {
          [page.id]: { environmentId: ENV, remotePageId: 'host-browser-page' }
        },
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.browserTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.browserPagesByWorkspace?.[workspace.id]).toBeUndefined()
    expect(patch.remoteBrowserPageHandlesByPageId?.[page.id]).toBeUndefined()
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeBrowserTabId).toBeNull()
    expect(patch.activeBrowserTabIdByWorktree?.[WT]).toBeNull()
    expect(patch.activeTabType).toBe('terminal')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('hydrates active host markdown tabs as remote editor tabs', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: HOST_SURFACE_ID,
            title: 'host shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'markdown',
            id: 'host-readme-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'edit',
            isDirty: true,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'draft:1'
          }
        ],
        { activeTabId: 'host-readme-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const terminalId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.openFiles).toMatchObject([
      {
        id: '/repo/README.md',
        filePath: '/repo/README.md',
        relativePath: 'README.md',
        worktreeId: WT,
        language: 'markdown',
        isDirty: true,
        runtimeEnvironmentId: ENV,
        mode: 'edit'
      }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'host-readme-unified',
          entityId: '/repo/README.md',
          contentType: 'editor',
          label: 'README.md'
        })
      ])
    )
    expect(patch.groupsByWorktree?.[WT]?.[0]).toMatchObject({
      activeTabId: 'host-readme-unified',
      tabOrder: [terminalId, 'host-readme-unified']
    })
    expect(patch.activeFileId).toBe('/repo/README.md')
    expect(patch.activeFileIdByWorktree?.[WT]).toBe('/repo/README.md')
    expect(patch.activeTabType).toBe('editor')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('editor')
  })

  it('uses local markdown preview file ids while preserving the host unified tab id', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot(
        [
          {
            type: 'markdown',
            id: 'host-preview-unified',
            title: 'README.md',
            filePath: '/repo/README.md',
            relativePath: 'README.md',
            language: 'markdown',
            mode: 'markdown-preview',
            isDirty: false,
            isActive: true,
            sourceFileId: '/repo/README.md',
            sourceFilePath: '/repo/README.md',
            sourceRelativePath: 'README.md',
            documentVersion: 'file:/repo/README.md'
          }
        ],
        { activeTabId: 'host-preview-unified', activeTabType: 'markdown' }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.openFiles).toMatchObject([
      {
        id: 'markdown-preview::/repo/README.md',
        filePath: '/repo/README.md',
        markdownPreviewSourceFileId: '/repo/README.md',
        mode: 'markdown-preview'
      }
    ])
    expect(patch.unifiedTabsByWorktree?.[WT]).toMatchObject([
      {
        id: 'host-preview-unified',
        entityId: 'markdown-preview::/repo/README.md',
        contentType: 'editor'
      }
    ])
    expect(patch.activeFileId).toBe('markdown-preview::/repo/README.md')
  })

  it('removes mirrored editor tabs when the host closes the file', () => {
    const openFile: OpenFile = {
      id: '/repo/README.md',
      filePath: '/repo/README.md',
      relativePath: 'README.md',
      worktreeId: WT,
      language: 'markdown',
      isDirty: false,
      runtimeEnvironmentId: ENV,
      mode: 'edit'
    }
    const unifiedTab: Tab = {
      id: 'host-readme-unified',
      entityId: openFile.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'editor',
      label: 'README.md',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW - 10,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeFileId: openFile.id,
        activeFileIdByWorktree: { [WT]: openFile.id },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        openFiles: [openFile],
        unifiedTabsByWorktree: { [WT]: [unifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: unifiedTab.id,
              tabOrder: [unifiedTab.id],
              recentTabIds: [unifiedTab.id]
            }
          ]
        }
      }),
      makeSnapshot([], { activeTabId: null, activeTabType: null }),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.openFiles).toEqual([])
    expect(patch.unifiedTabsByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]).toBeUndefined()
    expect(patch.activeFileId).toBeNull()
    expect(patch.activeFileIdByWorktree?.[WT]).toBeNull()
    expect(patch.activeTabType).toBe('terminal')
    expect(patch.activeTabTypeByWorktree?.[WT]).toBe('terminal')
  })

  it('mirrors pending terminal handles without attaching a stale PTY', () => {
    const state = makeState()
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'pending shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(mirroredId).toBeTruthy()
    expect(patch.tabsByWorktree?.[WT]).toMatchObject([
      {
        id: mirroredId,
        ptyId: null,
        title: 'pending shell',
        worktreeId: WT
      }
    ])
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toBeUndefined()
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      ptyIdsByLeafId: {}
    })
    expect(patch.activeTabId).toBe(mirroredId)
  })
})

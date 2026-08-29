import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('removes stale scrollback refs from mirrored terminal layouts', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const ptyId = 'remote:web-env-1@@terminal-1'
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId,
      worktreeId: WT,
      title: 'host shell',
      defaultTitle: 'host shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: [ptyId] },
        terminalLayoutsByTabId: {
          [mirroredId]: {
            root: { type: 'leaf', leafId: LEAF_ID },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF_ID]: ptyId },
            scrollbackRefsByLeafId: { [LEAF_ID]: 'v1-stale-ref' }
          }
        }
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

    expect(patch.terminalLayoutsByTabId?.[mirroredId]).toMatchObject({
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: ptyId }
    })
    expect(patch.terminalLayoutsByTabId?.[mirroredId]?.scrollbackRefsByLeafId).toBeUndefined()
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

  it('preserves local browser position when appending a new remote terminal', () => {
    const firstTerminalId = toWebTerminalSurfaceTabId('host-tab-1')
    const secondTerminalId = toWebTerminalSurfaceTabId('host-tab-2')
    const localBrowserWorkspace: BrowserWorkspace = {
      id: 'local-browser-workspace',
      worktreeId: WT,
      label: undefined,
      sessionProfileId: null,
      activePageId: 'local-browser-page',
      pageIds: ['local-browser-page'],
      url: 'about:blank',
      title: 'New Browser Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW + 1
    }
    const localBrowserPage: BrowserPage = {
      id: 'local-browser-page',
      workspaceId: localBrowserWorkspace.id,
      worktreeId: WT,
      url: 'about:blank',
      title: 'New Browser Tab',
      loading: false,
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      loadError: null,
      createdAt: NOW + 1,
      browserRuntimeEnvironmentId: null,
      viewportPresetId: null
    }
    const localBrowserTab: Tab = {
      id: 'local-browser-tab',
      entityId: localBrowserWorkspace.id,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'browser',
      label: 'New Browser Tab',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: NOW + 1,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: {
          [WT]: [
            {
              id: firstTerminalId,
              ptyId: 'remote:web-env-1@@terminal-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW
            }
          ]
        },
        browserTabsByWorktree: { [WT]: [localBrowserWorkspace] },
        browserPagesByWorkspace: { [localBrowserWorkspace.id]: [localBrowserPage] },
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: firstTerminalId,
              entityId: firstTerminalId,
              groupId: 'host-group-1',
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW,
              isPreview: false,
              isPinned: false
            },
            localBrowserTab
          ]
        },
        tabBarOrderByWorktree: { [WT]: [firstTerminalId, localBrowserTab.id] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: localBrowserTab.id,
              tabOrder: [firstTerminalId, localBrowserTab.id]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-tab-1::${LEAF_ID}`,
            title: 'Terminal 1',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'terminal',
            id: `host-tab-2::${SECOND_LEAF_ID}`,
            title: 'Terminal 2',
            parentTabId: 'host-tab-2',
            leafId: SECOND_LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-2'
          }
        ],
        {
          activeTabId: `host-tab-2::${SECOND_LEAF_ID}`,
          tabGroups: [
            {
              id: 'host-group-1',
              activeTabId: 'host-tab-2',
              tabOrder: ['host-tab-1', 'host-tab-2']
            }
          ]
        }
      ),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabBarOrderByWorktree?.[WT]).toEqual([
      firstTerminalId,
      localBrowserTab.id,
      secondTerminalId
    ])
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
})

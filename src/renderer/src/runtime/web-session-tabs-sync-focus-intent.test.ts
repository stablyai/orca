import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { recordWebSessionFocusIntent } from './web-session-focus-intent'
import type { Tab } from '../../../shared/tab-types'
import type { OpenFile } from '../store/slices/editor'
import {
  acceptReplayedWebSessionTabsSnapshot,
  applyFreshWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  ENV,
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

  it('does not let repeated remote terminal status snapshots steal local tab focus', () => {
    const agentTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const shellTabId = toWebTerminalSurfaceTabId('host-tab-2')
    const agentUnifiedTab: Tab = {
      id: agentTabId,
      entityId: agentTabId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'codex [working]',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    const shellUnifiedTab: Tab = {
      id: shellTabId,
      entityId: shellTabId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'shell',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: NOW + 1,
      isPreview: false,
      isPinned: false
    }

    const state = makeState({
      activeTabId: shellTabId,
      activeTabIdByWorktree: { [WT]: shellTabId },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      tabsByWorktree: {
        [WT]: [
          {
            id: agentTabId,
            ptyId: 'remote:web-env-1@@terminal-1',
            worktreeId: WT,
            title: 'codex [working]',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          },
          {
            id: shellTabId,
            ptyId: 'remote:web-env-1@@terminal-2',
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: NOW + 1
          }
        ]
      },
      unifiedTabsByWorktree: { [WT]: [agentUnifiedTab, shellUnifiedTab] },
      tabBarOrderByWorktree: { [WT]: [agentTabId, shellTabId] },
      groupsByWorktree: {
        [WT]: [
          {
            id: 'host-group-1',
            worktreeId: WT,
            activeTabId: shellTabId,
            tabOrder: [agentTabId, shellTabId],
            recentTabIds: [agentTabId, shellTabId]
          }
        ]
      }
    })
    const remoteActiveSnapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex [thinking]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-2::${SECOND_LEAF_ID}`,
          title: 'shell',
          parentTabId: 'host-tab-2',
          leafId: SECOND_LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ],
      {
        activeTabId: `host-tab-1::${LEAF_ID}`,
        activeTabType: 'terminal',
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: 'host-tab-1',
            tabOrder: ['host-tab-1', 'host-tab-2']
          }
        ]
      }
    )
    const patch = applyWebSessionTabsSnapshot(
      state,
      remoteActiveSnapshot,
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.activeTabId).toBeUndefined()
    expect(patch.activeTabIdByWorktree).toBeUndefined()
    // Why: client-owned placement — an ambient snapshot must not rewrite groups at all.
    expect(patch.groupsByWorktree).toBeUndefined()

    const followed = applyWebSessionTabsSnapshot(
      state,
      { ...remoteActiveSnapshot, navigationIntent: 'follow' },
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>
    expect(followed.activeTabIdByWorktree?.[WT]).toBe(agentTabId)
    expect(followed.groupsByWorktree?.[WT]?.[0]?.activeTabId).toBe(agentTabId)
  })

  it('does not let stale browser intent override a newer terminal selection', () => {
    const terminalId = toWebTerminalSurfaceTabId('host-terminal')
    const terminalTab: Tab = {
      id: terminalId,
      entityId: terminalId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'shell',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    recordWebSessionFocusIntent(
      { environmentId: ENV },
      WT,
      'host-browser',
      undefined,
      'previous-local-tab'
    )

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeTabId: terminalId,
        activeTabIdByWorktree: { [WT]: terminalId },
        activeTabType: 'terminal',
        activeTabTypeByWorktree: { [WT]: 'terminal' },
        tabsByWorktree: {
          [WT]: [
            {
              id: terminalId,
              ptyId: 'remote:web-env-1@@terminal-1',
              worktreeId: WT,
              title: 'shell',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW
            }
          ]
        },
        unifiedTabsByWorktree: { [WT]: [terminalTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: terminalId,
              tabOrder: [terminalId],
              recentTabIds: [terminalId]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-terminal::${LEAF_ID}`,
            title: 'shell',
            parentTabId: 'host-terminal',
            leafId: LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'browser',
            id: 'host-browser',
            title: 'Preview',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'file:///repo/index.html',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser', activeTabType: 'browser' }
      ),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.activeTabType).toBeUndefined()
    expect(patch.activeTabIdByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]?.[0]?.activeTabId).toBe(terminalId)
  })

  it('does not let stale browser intent override a newer editor selection', () => {
    const fileId = '/repo/index.html'
    const editorTab: Tab = {
      id: 'local-editor',
      entityId: fileId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'editor',
      label: 'index.html',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }
    recordWebSessionFocusIntent(
      { environmentId: ENV },
      WT,
      'host-browser',
      undefined,
      'previous-local-tab'
    )

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeFileId: fileId,
        activeFileIdByWorktree: { [WT]: fileId },
        activeTabType: 'editor',
        activeTabTypeByWorktree: { [WT]: 'editor' },
        openFiles: [
          {
            id: fileId,
            filePath: fileId,
            relativePath: 'index.html',
            worktreeId: WT,
            language: 'html',
            isDirty: false,
            runtimeEnvironmentId: ENV,
            mode: 'edit',
            mirroredFromRuntimeSession: true
          } as OpenFile
        ],
        unifiedTabsByWorktree: { [WT]: [editorTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: editorTab.id,
              tabOrder: [editorTab.id],
              recentTabIds: [editorTab.id]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'file',
            id: 'host-editor',
            title: 'index.html',
            filePath: fileId,
            relativePath: 'index.html',
            language: 'html',
            isDirty: false,
            isActive: false
          },
          {
            type: 'browser',
            id: 'host-browser',
            title: 'Preview',
            browserWorkspaceId: 'host-browser-workspace',
            browserPageId: 'host-browser-page',
            url: 'file:///repo/index.html',
            loading: false,
            canGoBack: false,
            canGoForward: false,
            isActive: true
          }
        ],
        { activeTabId: 'host-browser', activeTabType: 'browser' }
      ),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.activeTabType).toBeUndefined()
    expect(patch.activeFileIdByWorktree?.[WT]).toBeUndefined()
    expect(patch.groupsByWorktree?.[WT]?.[0]?.activeTabId).toBe('host-editor')
  })

  it('focuses a caller-created terminal even when an older host leaves it inactive', () => {
    const existingTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const newTabId = toWebTerminalSurfaceTabId('host-tab-2')
    // Simulate createWebRuntimeSessionTerminal recording focus intent for the new tab.
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-2')
    const existingUnifiedTab: Tab = {
      id: existingTabId,
      entityId: existingTabId,
      groupId: 'host-group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'shell',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        activeTabId: existingTabId,
        activeTabIdByWorktree: { [WT]: existingTabId },
        activeTabType: 'terminal',
        activeTabTypeByWorktree: { [WT]: 'terminal' },
        tabsByWorktree: {
          [WT]: [
            {
              id: existingTabId,
              ptyId: 'remote:web-env-1@@terminal-1',
              worktreeId: WT,
              title: 'shell',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: NOW
            }
          ]
        },
        unifiedTabsByWorktree: { [WT]: [existingUnifiedTab] },
        tabBarOrderByWorktree: { [WT]: [existingTabId] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'host-group-1',
              worktreeId: WT,
              activeTabId: existingTabId,
              tabOrder: [existingTabId],
              recentTabIds: [existingTabId]
            }
          ]
        }
      }),
      makeSnapshot(
        [
          {
            type: 'terminal',
            id: `host-tab-1::${LEAF_ID}`,
            title: 'shell',
            parentTabId: 'host-tab-1',
            leafId: LEAF_ID,
            isActive: true,
            status: 'ready',
            terminal: 'terminal-1'
          },
          {
            type: 'terminal',
            id: `host-tab-2::${SECOND_LEAF_ID}`,
            title: 'new shell',
            parentTabId: 'host-tab-2',
            leafId: SECOND_LEAF_ID,
            isActive: false,
            status: 'ready',
            terminal: 'terminal-2'
          }
        ],
        {
          activeTabId: `host-tab-1::${LEAF_ID}`,
          activeTabType: 'terminal',
          tabGroups: [
            {
              id: 'host-group-1',
              activeTabId: 'host-tab-1',
              tabOrder: ['host-tab-1', 'host-tab-2']
            }
          ]
        }
      ),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.activeTabIdByWorktree?.[WT]).toBe(newTabId)
    expect(patch.groupsByWorktree?.[WT]?.[0]?.activeTabId).toBe(newTabId)
  })

  it('replays a snapshot that beat the RPC response and focuses the exact adopted leaf', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const root = {
      type: 'split' as const,
      direction: 'horizontal' as const,
      first: { type: 'leaf' as const, leafId: LEAF_ID },
      second: { type: 'leaf' as const, leafId: SECOND_LEAF_ID }
    }
    const currentLayout = {
      root,
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: SECOND_LEAF_ID,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1',
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-2'
      }
    }
    const state = makeState({
      activeTabId: mirroredTabId,
      activeTabIdByWorktree: { [WT]: mirroredTabId },
      tabsByWorktree: {
        [WT]: [
          {
            id: mirroredTabId,
            ptyId: 'remote:web-env-1@@terminal-2',
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      },
      terminalLayoutsByTabId: { [mirroredTabId]: currentLayout }
    })
    const snapshot = makeSnapshot(
      [
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: currentLayout,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'shell',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          parentLayout: currentLayout,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ],
      {
        tabGroups: [
          {
            id: 'host-group-1',
            activeTabId: 'host-tab-1',
            tabOrder: ['host-tab-1']
          }
        ]
      }
    )

    const subscriptionPatch = applyFreshWebSessionTabsSnapshot(state, snapshot, ENV, NOW)
    const afterSubscription = {
      ...state,
      ...(subscriptionPatch as Partial<WebSessionTabsSyncState>)
    }
    expect(afterSubscription.terminalLayoutsByTabId[mirroredTabId]?.activeLeafId).toBe(
      SECOND_LEAF_ID
    )

    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-1', LEAF_ID)
    acceptReplayedWebSessionTabsSnapshot(ENV, WT)
    const replayPatch = applyFreshWebSessionTabsSnapshot(
      afterSubscription,
      snapshot,
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(replayPatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe('remote:web-env-1@@terminal-1')
    expect(replayPatch.terminalLayoutsByTabId?.[mirroredTabId]).toMatchObject({
      activeLeafId: LEAF_ID,
      expandedLeafId: LEAF_ID
    })
  })

  it('retains exact-leaf focus intent when a split sibling publishes first', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const siblingPtyId = 'remote:web-env-1@@terminal-2'
    const state = makeState({
      activeTabId: mirroredTabId,
      activeTabIdByWorktree: { [WT]: mirroredTabId },
      tabsByWorktree: {
        [WT]: [
          {
            id: mirroredTabId,
            ptyId: siblingPtyId,
            worktreeId: WT,
            title: 'shell',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      }
    })
    const sibling = {
      type: 'terminal' as const,
      id: `host-tab-1::${SECOND_LEAF_ID}`,
      title: 'shell',
      parentTabId: 'host-tab-1',
      leafId: SECOND_LEAF_ID,
      isActive: true,
      status: 'ready' as const,
      terminal: 'terminal-2'
    }
    recordWebSessionFocusIntent({ environmentId: ENV }, WT, 'host-tab-1', LEAF_ID)

    const partialPatch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([sibling]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>
    expect(partialPatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe(siblingPtyId)

    const afterPartial = { ...state, ...partialPatch }
    const completePatch = applyWebSessionTabsSnapshot(
      afterPartial,
      makeSnapshot([
        sibling,
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(completePatch.tabsByWorktree?.[WT]?.[0]?.ptyId).toBe('remote:web-env-1@@terminal-1')
    expect(completePatch.terminalLayoutsByTabId?.[mirroredTabId]?.activeLeafId).toBe(LEAF_ID)
  })

  it('does not let repeated remote split status snapshots steal local pane focus', () => {
    const mirroredTabId = toWebTerminalSurfaceTabId('host-tab-1')
    const currentLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: LEAF_ID },
        second: { type: 'leaf' as const, leafId: SECOND_LEAF_ID }
      },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1',
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-2'
      }
    }

    const state = makeState({
      activeTabId: mirroredTabId,
      activeTabIdByWorktree: { [WT]: mirroredTabId },
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { [WT]: 'terminal' },
      tabsByWorktree: {
        [WT]: [
          {
            id: mirroredTabId,
            ptyId: 'remote:web-env-1@@terminal-2',
            worktreeId: WT,
            title: 'right pane',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: NOW
          }
        ]
      },
      terminalLayoutsByTabId: { [mirroredTabId]: currentLayout }
    })

    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'codex [thinking]',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout: {
            ...currentLayout,
            activeLeafId: LEAF_ID
          },
          isActive: true,
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
            ...currentLayout,
            activeLeafId: LEAF_ID
          },
          isActive: false,
          status: 'ready',
          terminal: 'terminal-2'
        }
      ]),
      ENV,
      NOW + 10
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredTabId,
      ptyId: 'remote:web-env-1@@terminal-2',
      title: 'right pane'
    })
    // No layout patch at all, and the effective layout keeps the local active leaf.
    expect(patch.terminalLayoutsByTabId).toBeUndefined()
    expect({ ...state, ...patch }.terminalLayoutsByTabId[mirroredTabId]?.activeLeafId).toBe(
      SECOND_LEAF_ID
    )
  })
})

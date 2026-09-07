import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyWebSessionTabsSnapshot, type WebSessionTabsSyncState } from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
  SECOND_LEAF_ID,
  THIRD_LEAF_ID,
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
          launchAgent: 'codex',
          startupCwd: '/worktree/packages/web',
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
        launchAgent: 'codex',
        startupCwd: '/worktree/packages/web',
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

  it('drops mirrored launch intent when a later host snapshot omits it', () => {
    const existingTab: TerminalTab = {
      id: toWebTerminalSurfaceTabId('host-tab-1'),
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'Codex',
      defaultTitle: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'codex'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [existingTab.id]: ['remote:web-env-1@@terminal-1'] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: existingTab.id,
      title: 'zsh'
    })
    expect(patch.tabsByWorktree?.[WT]?.[0]?.launchAgent).toBeUndefined()
  })

  it('drops mirrored startup cwd when a later host snapshot omits it', () => {
    const existingTab: TerminalTab = {
      id: toWebTerminalSurfaceTabId('host-tab-1'),
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'zsh',
      defaultTitle: 'zsh',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      startupCwd: '/worktree/packages/web'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [existingTab.id]: ['remote:web-env-1@@terminal-1'] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: existingTab.id,
      title: 'zsh'
    })
    expect(patch.tabsByWorktree?.[WT]?.[0]?.startupCwd).toBeUndefined()
  })

  it('adopts host viewMode when this client has no prior tab', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'zsh',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          viewMode: 'chat',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.tabsByWorktree?.[WT]?.[0]?.viewMode).toBe('chat')
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)?.viewMode
    ).toBe('chat')
  })

  it('keeps the client viewMode when an in-flight host snapshot echoes the old value', () => {
    // Echo-window: client just toggled to chat; a host snapshot carrying the
    // pre-toggle 'terminal' value must not revert it (mirrors color/pin rule).
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: 'remote:web-env-1@@terminal-1',
      worktreeId: WT,
      title: 'old title',
      defaultTitle: 'old title',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      viewMode: 'chat'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: ['remote:web-env-1@@terminal-1'] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          // Title differs so the reconcile emits a tabsByWorktree delta; the echo
          // rule must still keep the client's optimistic 'chat' viewMode.
          title: 'new title',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          viewMode: 'terminal',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]?.title).toBe('new title')
    expect(patch.tabsByWorktree?.[WT]?.[0]?.viewMode).toBe('chat')
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)?.viewMode
    ).toBe('chat')
  })

  it('preserves quick command labels from host terminal surfaces', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Run tests',
          quickCommandLabel: 'Run tests',
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
    expect(patch.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredId,
      quickCommandLabel: 'Run tests',
      title: 'Run tests'
    })
    expect(
      patch.unifiedTabsByWorktree?.[WT]?.find((tab) => tab.entityId === mirroredId)
        ?.quickCommandLabel
    ).toBe('Run tests')
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

  it('deduplicates mirrored leaves that claim the same remote PTY', () => {
    const parentLayout = {
      root: {
        type: 'split' as const,
        direction: 'horizontal' as const,
        first: { type: 'leaf' as const, leafId: LEAF_ID },
        second: { type: 'leaf' as const, leafId: SECOND_LEAF_ID }
      },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null
    }
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'stale mirror',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          parentLayout,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1',
          agentStatus: {
            state: 'working',
            prompt: 'stale duplicate',
            updatedAt: NOW - 100,
            stateStartedAt: NOW - 1_000,
            agentType: 'pi',
            paneKey: makePaneKey('host-tab-1', LEAF_ID),
            terminalTitle: 'Pi ready',
            stateHistory: []
          }
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'Pi ready',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          parentLayout,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1',
          launchAgent: 'omp'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    const mirroredId = patch.tabsByWorktree?.[WT]?.[0]?.id
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toEqual(['remote:web-env-1@@terminal-1'])
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toEqual({
      root: { type: 'leaf', leafId: SECOND_LEAF_ID },
      activeLeafId: SECOND_LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: {
        [SECOND_LEAF_ID]: 'remote:web-env-1@@terminal-1'
      }
    })
    expect(Object.keys(patch.agentStatusByPaneKey ?? {})).toEqual([
      makePaneKey(mirroredId!, SECOND_LEAF_ID)
    ])
    expect(patch.agentStatusByPaneKey?.[makePaneKey(mirroredId!, SECOND_LEAF_ID)]).toMatchObject({
      prompt: 'stale duplicate',
      paneKey: makePaneKey(mirroredId!, SECOND_LEAF_ID),
      agentType: 'omp',
      terminalTitle: 'OMP ready'
    })
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

  it('retains a known title while a pending surface reports its placeholder', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const priorPtyId = 'remote:web-env-1@@terminal-1'
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: priorPtyId,
      worktreeId: WT,
      title: 'pnpm dev',
      defaultTitle: 'pnpm dev',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: [priorPtyId] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Terminal',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]?.title).toBe('pnpm dev')
  })

  it('adopts a real title after a pending surface becomes ready', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const priorPtyId = 'remote:web-env-1@@terminal-1'
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: priorPtyId,
      worktreeId: WT,
      title: 'pnpm dev',
      defaultTitle: 'pnpm dev',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [existingTab] },
        ptyIdsByTabId: { [mirroredId]: [priorPtyId] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'gal@host: ~/dev',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.[0]?.title).toBe('gal@host: ~/dev')
  })

  it('retains the exact prior pane binding while a mirrored surface is pending', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const priorPtyId = 'remote:web-env-1@@terminal-1'
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: priorPtyId,
      worktreeId: WT,
      title: 'host shell',
      defaultTitle: 'host shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW
    }

    const state = makeState({
      tabsByWorktree: { [WT]: [existingTab] },
      ptyIdsByTabId: { [mirroredId]: [priorPtyId] },
      terminalLayoutsByTabId: {
        [mirroredId]: {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: priorPtyId }
        }
      }
    })
    const patch = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'reconnecting shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    const nextState = { ...state, ...patch } as WebSessionTabsSyncState

    expect(nextState.tabsByWorktree?.[WT]?.[0]).toMatchObject({
      id: mirroredId,
      ptyId: priorPtyId,
      title: 'reconnecting shell'
    })
    expect(nextState.terminalLayoutsByTabId?.[mirroredId]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: priorPtyId
    })
  })

  it('retains only matching-environment pending bindings and never invents a sibling binding', () => {
    const mirroredId = toWebTerminalSurfaceTabId('host-tab-1')
    const matchingPtyId = 'remote:web-env-1@@terminal-1'
    const foreignPtyId = 'remote:web-env-2@@terminal-2'
    const existingTab: TerminalTab = {
      id: mirroredId,
      ptyId: matchingPtyId,
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
        ptyIdsByTabId: { [mirroredId]: [matchingPtyId, foreignPtyId] },
        terminalLayoutsByTabId: {
          [mirroredId]: {
            root: {
              type: 'split',
              direction: 'horizontal',
              first: { type: 'leaf', leafId: LEAF_ID },
              second: { type: 'leaf', leafId: SECOND_LEAF_ID }
            },
            activeLeafId: LEAF_ID,
            expandedLeafId: null,
            ptyIdsByLeafId: {
              [LEAF_ID]: matchingPtyId,
              [SECOND_LEAF_ID]: foreignPtyId
            }
          }
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'pending matching pane',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          status: 'pending-handle',
          terminal: null
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'pending foreign pane',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          isActive: false,
          status: 'pending-handle',
          terminal: null
        }
      ]),
      ENV,
      NOW + 1
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.terminalLayoutsByTabId?.[mirroredId]?.ptyIdsByLeafId).toEqual({
      [LEAF_ID]: matchingPtyId
    })
    expect(patch.ptyIdsByTabId?.[mirroredId]).toEqual([matchingPtyId])
  })

  it('does not attach a ready sibling PTY to an active pending split leaf', () => {
    const patch = applyWebSessionTabsSnapshot(
      makeState(),
      makeSnapshot([
        {
          type: 'terminal',
          id: `host-tab-1::${LEAF_ID}`,
          title: 'ready shell',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${SECOND_LEAF_ID}`,
          title: 'duplicate ready shell',
          parentTabId: 'host-tab-1',
          leafId: SECOND_LEAF_ID,
          isActive: false,
          status: 'ready',
          terminal: 'terminal-1'
        },
        {
          type: 'terminal',
          id: `host-tab-1::${THIRD_LEAF_ID}`,
          title: 'pending shell',
          parentTabId: 'host-tab-1',
          leafId: THIRD_LEAF_ID,
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
    expect(patch.ptyIdsByTabId?.[mirroredId!]).toEqual(['remote:web-env-1@@terminal-1'])
    expect(patch.terminalLayoutsByTabId?.[mirroredId!]).toMatchObject({
      root: {
        type: 'split',
        first: { type: 'leaf', leafId: LEAF_ID },
        second: { type: 'leaf', leafId: THIRD_LEAF_ID }
      },
      activeLeafId: THIRD_LEAF_ID,
      ptyIdsByLeafId: {
        [LEAF_ID]: 'remote:web-env-1@@terminal-1'
      }
    })
    expect(patch.activeTabId).toBe(mirroredId)
    expect(patch.activeTabIdByWorktree?.[WT]).toBe(mirroredId)
  })
})

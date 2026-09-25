import { describe, expect, it } from 'vitest'
import { createTerminalAttentionSurface } from './terminal-attention-surface'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { resolveAgentAttention } from '@/attention/agent-attention-policy'

const WORKSPACE = 'wt-1'
const TAB = 'tab-1'
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = makePaneKey(TAB, LEAF)

type TestStore = ReturnType<typeof createTestStore>

function seedLiveTab(): TestStore {
  const store = createTestStore()
  store.setState({
    tabsByWorktree: { [WORKSPACE]: [makeTab({ id: TAB, worktreeId: WORKSPACE })] },
    ptyIdsByTabId: { [TAB]: ['pty-1'] },
    terminalLayoutsByTabId: {
      [TAB]: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty-1' }
      }
    }
  })
  return store
}

function surfaceFor(store: TestStore): ReturnType<typeof createTerminalAttentionSurface> {
  return createTerminalAttentionSurface(store.getState())
}

describe('createTerminalAttentionSurface', () => {
  it('admits a live pane and reports its owning tab as the container', () => {
    const surface = surfaceFor(seedLiveTab())
    expect(surface.hasLiveSession({ workspaceId: WORKSPACE, surfaceKey: PANE })).toBe(true)
    expect(
      surface.admitSurface(
        { workspaceId: WORKSPACE, surfaceKey: PANE },
        { hasLiveSession: true, hasFreshActivityEvidence: false }
      )
    ).toEqual({ admitted: true, groupId: TAB })
  })

  it('rejects a leaf the tab layout no longer contains as superseded', () => {
    const store = seedLiveTab()
    const surface = surfaceFor(store)
    expect(
      surface.admitSurface(
        { workspaceId: WORKSPACE, surfaceKey: makePaneKey(TAB, OTHER_LEAF) },
        { hasLiveSession: true, hasFreshActivityEvidence: false }
      )
    ).toEqual({ admitted: false, cause: 'superseded-surface' })
  })

  it('rejects a surface key that carries no tab id', () => {
    const surface = surfaceFor(seedLiveTab())
    expect(
      surface.admitSurface(
        { workspaceId: WORKSPACE, surfaceKey: 'not-a-pane-key' },
        { hasLiveSession: true, hasFreshActivityEvidence: false }
      )
    ).toEqual({ admitted: false, cause: 'unknown-surface' })
  })

  it('falls back to the known-pane gate when no live pty backs the tab', () => {
    const store = seedLiveTab()
    store.setState({ ptyIdsByTabId: {} })
    expect(
      surfaceFor(store).admitSurface(
        { workspaceId: WORKSPACE, surfaceKey: PANE },
        { hasLiveSession: false, hasFreshActivityEvidence: true }
      )
    ).toEqual({ admitted: true, groupId: TAB })
  })

  it('rejects a known pane whose only pty hint is suppressed', () => {
    const store = seedLiveTab()
    store.setState({
      tabsByWorktree: {
        [WORKSPACE]: [makeTab({ id: TAB, worktreeId: WORKSPACE, ptyId: 'pty-1' })]
      },
      ptyIdsByTabId: {},
      suppressedPtyExitIds: { 'pty-1': true }
    })
    expect(
      surfaceFor(store).admitSurface(
        { workspaceId: WORKSPACE, surfaceKey: PANE },
        { hasLiveSession: false, hasFreshActivityEvidence: true }
      )
    ).toEqual({ admitted: false, cause: 'superseded-surface' })
  })

  it('resolves the viewed subject from the tab layout active leaf', () => {
    expect(surfaceFor(seedLiveTab()).resolveViewedSubjectKey(TAB)).toBe(PANE)
  })

  it('resolves no viewed subject when the active leaf is not a terminal leaf', () => {
    const store = seedLiveTab()
    store.setState({
      terminalLayoutsByTabId: {
        [TAB]: {
          root: { type: 'leaf', leafId: 'chat-leaf' },
          activeLeafId: 'chat-leaf',
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })
    expect(surfaceFor(store).resolveViewedSubjectKey(TAB)).toBeNull()
  })

  it('counts only this workspace tabs when collecting outstanding attention', () => {
    const store = seedLiveTab()
    const foreignPane = makePaneKey('tab-elsewhere', OTHER_LEAF)
    store.setState({
      unreadAgentCompletionPanes: { [PANE]: 'agent-completion', [foreignPane]: 'agent-completion' },
      unreadTerminalTabs: { [TAB]: 'terminal-bell', 'tab-elsewhere': 'terminal-bell' }
    })
    expect(surfaceFor(store).collectWorkspaceAttentionRemainder(WORKSPACE)).toEqual({
      hasSurfaces: true,
      unreadSubjectKeys: [PANE],
      unreadGroupIds: [TAB]
    })
  })

  it('reports a workspace with no tabs as owning no surfaces', () => {
    const store = createTestStore()
    expect(surfaceFor(store).collectWorkspaceAttentionRemainder(WORKSPACE)).toEqual({
      hasSurfaces: false,
      unreadSubjectKeys: [],
      unreadGroupIds: []
    })
  })

  it('treats only the active leaf of the active tab as viewed', () => {
    const store = seedLiveTab()
    store.setState({ activeWorktreeId: WORKSPACE, activeTabId: TAB })
    const hidden = createTerminalAttentionSurface(store.getState())
    expect(hidden.isWorkspaceActive(WORKSPACE)).toBe(true)
    expect(hidden.isSurfaceViewed({ workspaceId: WORKSPACE, surfaceKey: PANE })).toBe(true)
    expect(
      hidden.isSurfaceViewed({
        workspaceId: WORKSPACE,
        surfaceKey: makePaneKey(TAB, OTHER_LEAF)
      })
    ).toBe(false)
  })

  describe('unread on a settled turn', () => {
    const FLOATING_TAB = 'tab-floating'
    const FLOATING_PANE = makePaneKey(FLOATING_TAB, LEAF)

    function unreadFor(store: TestStore, workspaceId: string, surfaceKey: string): boolean {
      const decision = resolveAgentAttention(
        {
          subject: { workspaceId, surfaceKey },
          reason: 'agent-completion',
          settlesTurn: true,
          hasFreshActivityEvidence: false,
          groupAttentionEnabled: true
        },
        createTerminalAttentionSurface(store.getState())
      )
      return decision.admitted && decision.unread !== null
    }

    function seedFloatingAgent(panelOpen: boolean): TestStore {
      const store = createTestStore()
      store.setState({
        settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: true },
        floatingWorkspacePanelOpen: panelOpen,
        activeView: 'terminal',
        activeWorktreeId: WORKSPACE,
        activeTabId: TAB,
        activeTabIdByWorktree: { [WORKSPACE]: TAB, [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB },
        tabsByWorktree: {
          [WORKSPACE]: [makeTab({ id: TAB, worktreeId: WORKSPACE })],
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            makeTab({ id: FLOATING_TAB, worktreeId: FLOATING_TERMINAL_WORKTREE_ID })
          ]
        },
        ptyIdsByTabId: { [FLOATING_TAB]: ['pty-floating'] },
        terminalLayoutsByTabId: {
          [FLOATING_TAB]: {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: 'pty-floating' }
          }
        }
      })
      return store
    }

    function seedMainSplit(): TestStore {
      const store = seedLiveTab()
      store.setState({
        activeView: 'terminal',
        activeWorktreeId: WORKSPACE,
        activeTabId: TAB,
        ptyIdsByTabId: { [TAB]: ['pty-1', 'pty-2'] },
        terminalLayoutsByTabId: {
          [TAB]: {
            root: {
              type: 'split',
              direction: 'vertical',
              first: { type: 'leaf', leafId: LEAF },
              second: { type: 'leaf', leafId: OTHER_LEAF }
            },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: 'pty-1', [OTHER_LEAF]: 'pty-2' }
          }
        }
      })
      return store
    }

    it('marks nothing for a floating agent pane shown in the open floating panel', () => {
      expect(unreadFor(seedFloatingAgent(true), FLOATING_TERMINAL_WORKTREE_ID, FLOATING_PANE)).toBe(
        false
      )
    })

    it('marks a floating agent pane unread while the floating panel is closed', () => {
      expect(
        unreadFor(seedFloatingAgent(false), FLOATING_TERMINAL_WORKTREE_ID, FLOATING_PANE)
      ).toBe(true)
    })

    it('marks the main active pane unread behind a non-terminal top-level view', () => {
      const store = seedMainSplit()
      store.setState({ activeView: 'tasks' })
      expect(unreadFor(store, WORKSPACE, PANE)).toBe(true)
    })

    it('marks nothing for the active leaf of the viewed main tab', () => {
      expect(unreadFor(seedMainSplit(), WORKSPACE, PANE)).toBe(false)
    })

    it('marks an inactive split leaf of the viewed main tab unread', () => {
      expect(unreadFor(seedMainSplit(), WORKSPACE, makePaneKey(TAB, OTHER_LEAF))).toBe(true)
    })
  })
})

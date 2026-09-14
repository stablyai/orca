import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  recordWebAgentSessionHandoff
} from './web-agent-session-handoff'
import {
  applyWebSessionTabsSnapshot,
  resolveHostSessionTabIdForWebSessionTab,
  type WebSessionTabsSyncState
} from './web-session-tabs-sync'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  NOW,
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

  it('keeps a provisional Claude tab when the host Claude surface is unrelated', () => {
    const staleLocalAgentTab: TerminalTab = {
      id: 'local-agent-tab',
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }
    const staleUnifiedTab: Tab = {
      id: 'local-agent-tab',
      entityId: 'local-agent-tab',
      groupId: 'group-1',
      worktreeId: WT,
      contentType: 'terminal',
      label: 'Claude',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      isPreview: false,
      isPinned: false
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [staleLocalAgentTab] },
        unifiedTabsByWorktree: { [WT]: [staleUnifiedTab] },
        groupsByWorktree: {
          [WT]: [
            {
              id: 'group-1',
              worktreeId: WT,
              activeTabId: 'local-agent-tab',
              tabOrder: ['local-agent-tab']
            }
          ]
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(2)
    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'local-agent-tab')).toBe(true)
    expect(patch.unifiedTabsByWorktree?.[WT]?.some((tab) => tab.id === 'local-agent-tab')).toBe(
      true
    )
  })

  it('replaces only the provisional tab with an exact structured-create handoff', () => {
    const provisional = (id: string): TerminalTab => ({
      id,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-b',
      hostTabId: 'host-tab-1',
      hostTerminalHandle: 'term_host-1'
    })

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: {
          [WT]: [provisional('provisional-a'), provisional('provisional-b')]
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Claude',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'claude',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'provisional-a')).toBe(true)
    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'provisional-b')).toBe(false)
    expect(patch.tabsByWorktree?.[WT]).toHaveLength(2)
  })

  it('retires an exact provisional handoff only after a post-create snapshot confirms exit', () => {
    const provisional = (id: string): TerminalTab => ({
      id,
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-exited',
      hostTabId: 'host-tab-exited',
      hostTerminalHandle: 'term_host-exited'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-unrelated',
      hostTabId: 'host-tab-still-in-flight',
      hostTerminalHandle: 'term_host-in-flight'
    })

    const state = makeState({
      tabsByWorktree: {
        [WT]: [provisional('provisional-unrelated'), provisional('provisional-exited')]
      }
    })
    const possiblyPreCreate = applyWebSessionTabsSnapshot(state, makeSnapshot([]), ENV, NOW)
    const possiblyPreCreateState = {
      ...state,
      ...(possiblyPreCreate as Partial<WebSessionTabsSyncState>)
    }
    expect(possiblyPreCreateState.tabsByWorktree[WT]?.map((tab) => tab.id)).toEqual([
      'provisional-unrelated',
      'provisional-exited'
    ])

    confirmWebAgentSessionHandoffAfterCreate({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-exited',
      hostTabId: 'host-tab-exited',
      hostTerminalHandle: 'term_host-exited'
    })
    const postCreate = applyWebSessionTabsSnapshot(
      state,
      makeSnapshot([]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(postCreate.tabsByWorktree?.[WT]?.map((tab) => tab.id)).toEqual(['provisional-unrelated'])
  })

  it('cleans provisional startup and automatic-resume state during exact handoff', () => {
    const provisionalTab: TerminalTab = {
      id: 'provisional-resume',
      ptyId: null,
      worktreeId: WT,
      title: 'Codex',
      defaultTitle: 'Codex',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'codex'
    }
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: provisionalTab.id,
      hostTabId: 'host-tab-1',
      hostTerminalHandle: 'term_host-1'
    })

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [provisionalTab] },
        pendingStartupByTabId: {
          [provisionalTab.id]: { command: "codex resume 'session-b'" },
          retained: { command: 'codex' }
        },
        automaticAgentResumeClaimsByTabId: {
          [provisionalTab.id]: {
            worktreeId: WT,
            launchAgent: 'codex',
            providerSession: { key: 'session_id', id: 'session-b' }
          },
          retained: {
            worktreeId: WT,
            launchAgent: 'codex',
            providerSession: { key: 'session_id', id: 'session-a' }
          }
        }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'codex',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.pendingStartupByTabId).toEqual({ retained: { command: 'codex' } })
    expect(patch.automaticAgentResumeClaimsByTabId).toEqual({
      retained: {
        worktreeId: WT,
        launchAgent: 'codex',
        providerSession: { key: 'session_id', id: 'session-a' }
      }
    })
  })

  it('keeps stale local agent tabs when the host mirror is for a different agent', () => {
    const staleLocalClaudeTab: TerminalTab = {
      id: 'local-claude-tab',
      ptyId: null,
      worktreeId: WT,
      title: 'Claude',
      defaultTitle: 'Claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: NOW,
      launchAgent: 'claude'
    }

    const patch = applyWebSessionTabsSnapshot(
      makeState({
        tabsByWorktree: { [WT]: [staleLocalClaudeTab] }
      }),
      makeSnapshot([
        {
          type: 'terminal',
          id: HOST_SURFACE_ID,
          title: 'Codex',
          parentTabId: 'host-tab-1',
          leafId: LEAF_ID,
          isActive: true,
          launchAgent: 'codex',
          status: 'ready',
          terminal: 'terminal-1'
        }
      ]),
      ENV,
      NOW
    ) as Partial<WebSessionTabsSyncState>

    expect(patch.tabsByWorktree?.[WT]).toHaveLength(2)
    expect(patch.tabsByWorktree?.[WT]?.some((tab) => tab.id === 'local-claude-tab')).toBe(true)
  })

  it('resolves a canonical agent tab before its confirming snapshot arrives', () => {
    recordWebAgentSessionHandoff({
      environmentId: ENV,
      worktreeId: WT,
      provisionalTabId: 'provisional-agent-tab',
      hostTabId: 'canonical-host-tab',
      hostTerminalHandle: 'term-canonical'
    })

    expect(
      resolveHostSessionTabIdForWebSessionTab(makeState(), {
        environmentId: ENV,
        worktreeId: WT,
        tabId: 'provisional-agent-tab'
      })
    ).toBe('canonical-host-tab')
  })
})

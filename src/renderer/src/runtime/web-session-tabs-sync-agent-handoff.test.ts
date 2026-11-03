import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  recordWebAgentSessionHandoff
} from './web-agent-session-handoff'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync/snapshot-api'
import './web-session-tabs-sync/tracking-mappings'
import type { WebSessionTabsSyncState } from './web-session-tabs-sync/state'
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
})

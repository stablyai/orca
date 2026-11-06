import { describe, expect, it } from 'vitest'
import { resolveAutoAckTabTargets } from './agent-auto-ack-targets'
import { computeLapsedManualUnreadProtections } from '@/attention/agent-attention-acknowledgement'
import { makeUnifiedTab } from '../store/slices/store-test-helpers'

import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'

const CODEX_LEAF_ID = '11111111-1111-4111-8111-111111111111'

// Codex Stop can migrate done state to retained rows before view acknowledgement; scan both live and retained maps or the row stays bold forever (codex-agent-row-bold-stuck.md). Test the pure target selector independently of DOM presence gates.

describe('resolveAutoAckTabTargets', () => {
  const FLOATING_TAB_ID = 'tab-floating'
  const withActiveTabs = (tabIds: Record<string, string>) => ({
    groupsByWorktree: Object.fromEntries(
      Object.entries(tabIds).map(([worktreeId, tabId]) => [
        worktreeId,
        [{ id: `${worktreeId}-group`, activeTabId: tabId }]
      ])
    ),
    activeGroupIdByWorktree: Object.fromEntries(
      Object.keys(tabIds).map((worktreeId) => [worktreeId, `${worktreeId}-group`])
    ),
    unifiedTabsByWorktree: Object.fromEntries(
      Object.entries(tabIds).map(([worktreeId, tabId]) => [
        worktreeId,
        [makeUnifiedTab({ id: tabId, worktreeId, groupId: `${worktreeId}-group` })]
      ])
    )
  })
  const baseState = {
    activeView: 'terminal',
    activeWorktreeId: 'wt-1',
    ...withActiveTabs({ [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID, 'wt-1': 'tab-1' }),
    settings: { ...getDefaultSettings('/home/test'), floatingTerminalEnabled: true },
    floatingWorkspacePanelOpen: true
  }
  const panelClosed = { floatingWorkspacePanelOpen: false }

  it('scans the active tab of every visible group of a split layout', () => {
    const state = {
      ...baseState,
      ...panelClosed,
      groupsByWorktree: {
        'wt-1': [
          { id: 'left', activeTabId: 'tab-1' },
          { id: 'right', activeTabId: 'tab-2' }
        ]
      },
      activeGroupIdByWorktree: { 'wt-1': 'right' },
      layoutByWorktree: {
        'wt-1': {
          type: 'split' as const,
          direction: 'horizontal' as const,
          first: { type: 'leaf' as const, groupId: 'left' },
          second: { type: 'leaf' as const, groupId: 'right' }
        }
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          makeUnifiedTab({ id: 'tab-1', worktreeId: 'wt-1', groupId: 'left' }),
          makeUnifiedTab({ id: 'tab-2', worktreeId: 'wt-1', groupId: 'right' })
        ]
      }
    }
    expect(resolveAutoAckTabTargets(state)).toEqual([
      { tabId: 'tab-2', worktreeId: 'wt-1', surfaceKind: 'terminal' },
      { tabId: 'tab-1', worktreeId: 'wt-1', surfaceKind: 'terminal' }
    ])
  })

  it('prefers the visible floating worktree when both worktrees claim one tab id', () => {
    expect(
      resolveAutoAckTabTargets({
        ...baseState,
        ...withActiveTabs({
          [FLOATING_TERMINAL_WORKTREE_ID]: FLOATING_TAB_ID,
          'wt-1': FLOATING_TAB_ID
        })
      })
    ).toEqual([
      { tabId: FLOATING_TAB_ID, worktreeId: FLOATING_TERMINAL_WORKTREE_ID, surfaceKind: 'terminal' }
    ])
  })
})

describe('computeLapsedManualUnreadProtections', () => {
  const paneKey = makePaneKey('tab-1', CODEX_LEAF_ID)

  it('keeps an active pane whose status row has not arrived yet (startup race)', () => {
    // Manual-unread hydration can precede status rows; missing evidence must not mean the agent moved on.
    const lapsed = computeLapsedManualUnreadProtections(
      {
        liveTurns: {},
        retainedTurns: {},
        manuallyUnreadTurnStartedAt: { [paneKey]: 1_000 }
      },
      new Set([paneKey])
    )
    expect(lapsed).toEqual([])
  })
})

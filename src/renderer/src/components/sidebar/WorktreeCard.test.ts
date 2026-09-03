import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

vi.mock('@/lib/agent-status', () => ({
  detectAgentStatusFromTitle: vi.fn((title: string) => {
    if (title.includes('permission')) {
      return 'permission'
    }
    if (title.includes('working')) {
      return 'working'
    }
    return null
  }),
  isExplicitAgentStatusFresh: vi.fn(
    (entry: AgentStatusEntry, now: number, staleAfterMs: number) =>
      now - entry.updatedAt <= staleAfterMs
  )
}))

import { getWorktreeStatus } from '@/lib/worktree-status'
import { shouldBeginWorktreeRename } from './WorktreeCard'

function makeTerminalTab(title: string): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: 'repo1::/tmp/wt',
    ptyId: 'pty-1',
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('getWorktreeStatus', () => {
  it('treats browser-only worktrees as active', () => {
    expect(getWorktreeStatus([], [{ id: 'browser-1' }], {})).toBe('active')
  })

  it('keeps terminal agent states higher priority than browser presence', () => {
    // Why: liveness gate now requires ptyIdsByTabId, not tab.ptyId. Pass a
    // populated live-pty map so this assertion exercises the live-tab branch.
    // Titles are real classifiable shapes: getWorktreeStatus reads the shared
    // classifier through pane-agent-evidence, which this file does not mock.
    // Why (STA-2926): the dot reads runtime pane titles, so publish each title on a pane rather
    // than relying on the tab title, which no longer feeds the heuristic on its own.
    const livePtyIds = { 'tab-1': ['pty-1'] }
    expect(
      getWorktreeStatus(
        [makeTerminalTab('Claude - action required')],
        [{ id: 'browser-1' }],
        livePtyIds,
        { 'tab-1': { 0: 'Claude - action required' } }
      )
    ).toBe('permission')
    expect(
      getWorktreeStatus([makeTerminalTab('mimo working')], [{ id: 'browser-1' }], livePtyIds, {
        'tab-1': { 0: 'mimo working' }
      })
    ).toBe('working')
  })
})

describe('shouldBeginWorktreeRename', () => {
  it('matches unscoped legacy rename requests by worktree id', () => {
    expect(shouldBeginWorktreeRename({ worktreeId: 'wt-1' }, 'wt-1', 'all:wt-1')).toBe(true)
  })

  it('matches row-scoped rename requests only on the target row', () => {
    const request = { worktreeId: 'wt-1', rowKey: 'all:wt-1' }

    expect(shouldBeginWorktreeRename(request, 'wt-1', 'all:wt-1')).toBe(true)
    expect(shouldBeginWorktreeRename(request, 'wt-1', 'pinned:wt-1')).toBe(false)
  })
})

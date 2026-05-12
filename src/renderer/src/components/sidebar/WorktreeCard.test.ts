import { describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'

vi.mock('@/lib/agent-status', () => ({
  detectAgentStatusFromTitle: vi.fn((title: string) => {
    if (title.includes('permission')) {
      return 'permission'
    }
    if (title.includes('working')) {
      return 'working'
    }
    return null
  })
}))

import { getWorktreeStatus } from '@/lib/worktree-status'

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
    const livePtyIds = { 'tab-1': ['pty-1'] }
    expect(
      getWorktreeStatus([makeTerminalTab('permission needed')], [{ id: 'browser-1' }], livePtyIds)
    ).toBe('permission')
    expect(
      getWorktreeStatus([makeTerminalTab('working hard')], [{ id: 'browser-1' }], livePtyIds)
    ).toBe('working')
  })
})

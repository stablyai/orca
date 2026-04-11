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
    expect(getWorktreeStatus([], [{ id: 'browser-1' }])).toBe('active')
  })

  it('keeps terminal agent states higher priority than browser presence', () => {
    expect(getWorktreeStatus([makeTerminalTab('permission needed')], [{ id: 'browser-1' }])).toBe(
      'permission'
    )
    expect(getWorktreeStatus([makeTerminalTab('working hard')], [{ id: 'browser-1' }])).toBe(
      'working'
    )
  })
})

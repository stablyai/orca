import { describe, expect, it, vi } from 'vitest'

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

import { getWorktreeStatus } from './WorktreeCard'

describe('getWorktreeStatus', () => {
  it('treats browser-only worktrees as active', () => {
    expect(getWorktreeStatus([], [{ id: 'browser-1' }])).toBe('active')
  })

  it('keeps terminal agent states higher priority than browser presence', () => {
    expect(
      getWorktreeStatus(
        [{ id: 'tab-1', ptyId: 'pty-1', title: 'permission needed' }],
        [{ id: 'browser-1' }]
      )
    ).toBe('permission')
    expect(
      getWorktreeStatus(
        [{ id: 'tab-1', ptyId: 'pty-1', title: 'working hard' }],
        [{ id: 'browser-1' }]
      )
    ).toBe('working')
  })
})

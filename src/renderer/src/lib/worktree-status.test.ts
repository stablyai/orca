import { describe, expect, it } from 'vitest'
import { getWorktreeStatus, getWorktreeStatusLabel } from './worktree-status'

describe('worktree-status', () => {
  it('prioritizes permission over other live activity states', () => {
    const status = getWorktreeStatus(
      [
        { ptyId: 'pty-working', title: 'claude [working]' },
        { ptyId: 'pty-permission', title: 'claude [permission]' }
      ],
      [{ id: 'browser-1' }]
    )

    expect(status).toBe('permission')
    expect(getWorktreeStatusLabel(status)).toBe('Needs permission')
  })

  it('treats browser-only worktrees as active', () => {
    const status = getWorktreeStatus([], [{ id: 'browser-1' }])

    expect(status).toBe('active')
  })

  it('returns inactive when neither tabs nor browser state are live', () => {
    expect(getWorktreeStatus([], [])).toBe('inactive')
  })
})

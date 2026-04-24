import { describe, expect, it } from 'vitest'
import { getWorktreeStatus, getWorktreeStatusLabel } from './worktree-status'

describe('worktree-status', () => {
  it('prioritizes permission over other live activity states', () => {
    const status = getWorktreeStatus(
      [
        { id: 'tab-1', ptyId: 'pty-working', title: 'claude [working]' },
        { id: 'tab-2', ptyId: 'pty-permission', title: 'claude [permission]' }
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

  it('reports working when any pane in a split-pane tab is working even if tab.title is idle', () => {
    // Regression: clicking between split panes rewrites tab.title to the
    // focused pane's title (see onActivePaneChange in
    // use-terminal-pane-lifecycle.ts). If the focused pane is idle while
    // another pane is still working, the sidebar spinner must stay spinning.
    const status = getWorktreeStatus(
      [{ id: 'tab-1', ptyId: 'pty-1', title: 'claude [done]' }],
      [],
      { 'tab-1': { 0: 'codex [working]', 1: 'claude [done]' } }
    )

    expect(status).toBe('working')
  })

  it('prefers pane-level permission status over tab.title', () => {
    const status = getWorktreeStatus(
      [{ id: 'tab-1', ptyId: 'pty-1', title: 'claude [done]' }],
      [],
      { 'tab-1': { 0: 'claude [permission]', 1: 'claude [done]' } }
    )

    expect(status).toBe('permission')
  })
})

import { describe, expect, it } from 'vitest'
import { countOpenRepoTerminalTabs } from './repo-removal'

describe('countOpenRepoTerminalTabs', () => {
  it('counts tabs with a PTY on the removed host only', () => {
    const state = {
      worktreesByRepo: {
        'repo-1': [
          { id: 'repo-1::/a', hostId: 'local' },
          { id: 'repo-1::/srv/a', hostId: 'ssh:box' }
        ]
      },
      detectedWorktreesByRepo: {},
      tabsByWorktree: {
        'repo-1::/a': [{ id: 'tab-live' }, { id: 'tab-no-pty' }],
        'repo-1::/srv/a': [{ id: 'tab-ssh' }]
      },
      ptyIdsByTabId: { 'tab-live': ['pty-1'], 'tab-no-pty': [], 'tab-ssh': ['pty-2'] }
    }

    expect(countOpenRepoTerminalTabs(state, 'repo-1', 'local')).toBe(1)
    expect(countOpenRepoTerminalTabs(state, 'repo-1', 'ssh:box')).toBe(1)
    expect(countOpenRepoTerminalTabs(state, 'repo-2', 'local')).toBe(0)
  })
})

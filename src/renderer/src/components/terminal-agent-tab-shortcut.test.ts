import { describe, expect, it, vi } from 'vitest'

vi.mock('../store', () => ({
  useAppStore: {
    getState: () => ({
      settings: {
        customAgentProfiles: [
          {
            id: 'codex-luna',
            name: 'Codex Luna',
            executable: 'codex',
            args: ['--model', 'luna'],
            isDefault: true
          }
        ]
      }
    })
  }
}))

import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'

describe('resolveTerminalAgentTabShortcut', () => {
  it('selects the default custom profile for the new-agent shortcut', () => {
    expect(
      resolveTerminalAgentTabShortcut({
        activeWorktreeId: 'worktree-1',
        keybindings: {},
        matchShortcut: (actionId) => actionId === 'tab.newAgent'
      })
    ).toEqual({
      actionId: 'tab.newAgent',
      agent: null,
      customAgentProfileId: 'codex-luna'
    })
  })
})

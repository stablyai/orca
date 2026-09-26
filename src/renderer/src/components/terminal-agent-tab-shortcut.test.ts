import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { resolveTerminalAgentTabShortcut } from './terminal-agent-tab-shortcut'

// Windows with a WSL runtime default: the legacy list follows WSL, the floating panel runs natively.
const state = {
  settings: {},
  folderWorkspaces: [],
  projectGroups: [],
  repos: [
    { id: 'ssh-repo', connectionId: 'conn-1', executionHostId: 'ssh:conn-1', path: '/srv/app' }
  ],
  worktreesByRepo: {},
  detectedAgentIds: ['claude'],
  localDetectedAgentIdsByContext: { host: ['codex'] },
  remoteDetectedAgentIds: { 'conn-1': ['gemini'] },
  runtimeDetectedAgentIds: {}
}

vi.mock('../store', () => ({ useAppStore: { getState: () => state } }))

describe('resolveTerminalAgentTabShortcut', () => {
  it("picks the floating panel's default agent from its native host detection", () => {
    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      keybindings: {},
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })

    expect(shortcut).toEqual({ actionId: 'tab.newAgent', agent: 'codex' })
  })

  it('keeps the local list when the worktree host is unresolved', () => {
    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'unhydrated-repo::/work/tree',
      keybindings: {},
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })

    expect(shortcut).toEqual({ actionId: 'tab.newAgent', agent: 'claude' })
  })

  it('reads the SSH list for an SSH repo whose worktree row has not loaded yet', () => {
    const shortcut = resolveTerminalAgentTabShortcut({
      activeWorktreeId: 'ssh-repo::/srv/app-feature',
      keybindings: {},
      matchShortcut: (actionId) => actionId === 'tab.newAgent'
    })

    expect(shortcut).toEqual({ actionId: 'tab.newAgent', agent: 'gemini' })
  })
})

import { describe, expect, it } from 'vitest'

import { verifyTerminalRevealIdentity } from './terminal-reveal-identity'

const expected = {
  worktreeId: 'worktree-1',
  tabId: 'tab-1',
  leafId: 'leaf-1',
  ptyId: 'pty-1'
}

const mismatchCases: {
  name: string
  state: Parameters<typeof verifyTerminalRevealIdentity>[0]
}[] = [
  {
    name: 'worktree',
    state: {
      tabsByWorktree: { 'worktree-2': [{ id: 'tab-1' }] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1' } }
      }
    }
  },
  {
    name: 'leaf',
    state: {
      tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { 'leaf-2': 'pty-1' } }
      }
    }
  },
  {
    name: 'pty',
    state: {
      tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
      terminalLayoutsByTabId: {
        'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-2' } }
      }
    }
  }
]

describe('verifyTerminalRevealIdentity', () => {
  it('returns the exact fresh renderer binding', () => {
    expect(
      verifyTerminalRevealIdentity(
        {
          tabsByWorktree: { 'worktree-1': [{ id: 'tab-1' }] },
          terminalLayoutsByTabId: {
            'tab-1': { ptyIdsByLeafId: { 'leaf-1': 'pty-1' } }
          }
        },
        expected
      )
    ).toEqual(expected)
  })

  it.each(mismatchCases)('rejects a mismatched $name owner', ({ state }) => {
    expect(() => verifyTerminalRevealIdentity(state, expected)).toThrow(
      'terminal_reveal_identity_mismatch'
    )
  })
})

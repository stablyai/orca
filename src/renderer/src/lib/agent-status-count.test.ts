import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../shared/types'
import { countWorkingAgents } from './agent-status'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: 'pty-1',
    worktreeId: 'wt-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

describe('countWorkingAgents', () => {
  it('counts each live working tab when pane-level titles are unavailable', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [
            makeTab({ id: 'tab-1', title: '⠂ Claude Code' }),
            makeTab({ id: 'tab-2', title: '✦ Gemini CLI' })
          ],
          'wt-2': [makeTab({ id: 'tab-3', worktreeId: 'wt-2', title: '⠋ Codex is thinking' })]
        },
        runtimePaneTitlesByTabId: {}
      })
    ).toBe(3)
  })

  it('counts working panes separately within the same tab', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: '⠂ Claude Code',
            2: '✦ Gemini CLI',
            3: '✳ Claude Code'
          }
        }
      })
    ).toBe(2)
  })

  it('ignores non-working or non-live tabs', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [
            makeTab({ id: 'tab-1', title: '✳ Claude Code' }),
            makeTab({ id: 'tab-2', title: '✋ Gemini CLI' }),
            makeTab({ id: 'tab-3', title: 'bash' }),
            makeTab({ id: 'tab-4', title: '⠂ Claude Code', ptyId: null })
          ]
        },
        runtimePaneTitlesByTabId: {}
      })
    ).toBe(0)
  })

  it('prefers pane-level titles over the coarse tab title when available', () => {
    expect(
      countWorkingAgents({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', title: '⠂ Claude Code' })]
        },
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: '✳ Claude Code',
            2: 'bash'
          }
        }
      })
    ).toBe(0)
  })
})

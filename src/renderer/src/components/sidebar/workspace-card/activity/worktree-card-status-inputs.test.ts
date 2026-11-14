import { describe, expect, it } from 'vitest'

import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import {
  EMPTY_PANE_FOREGROUND_AGENTS,
  selectPaneForegroundAgentsForWorktree
} from './worktree-card-status-inputs'

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: 'pty-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('worktree card status input selectors', () => {
  it("selects only this worktree's pane foreground reads, keeping identity across other writes", () => {
    const worktreeId = 'repo1::/path/wt1'
    const ownPaneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
    const ownEntry = { agent: 'codex' as const, shellForeground: false }
    const state: Parameters<typeof selectPaneForegroundAgentsForWorktree>[0] = {
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)],
        other: [makeTab('tab-2', 'other')]
      },
      paneForegroundAgentByPaneKey: {
        [ownPaneKey]: ownEntry,
        'tab-2:22222222-2222-4222-8222-222222222222': { agent: 'claude', shellForeground: false }
      }
    }
    const selected = selectPaneForegroundAgentsForWorktree(state, worktreeId)
    expect(selected).toEqual({ [ownPaneKey]: ownEntry })

    const otherWrite = {
      ...state,
      paneForegroundAgentByPaneKey: {
        ...state.paneForegroundAgentByPaneKey,
        'tab-2:22222222-2222-4222-8222-222222222222': { agent: null, shellForeground: true }
      }
    }
    expect(selectPaneForegroundAgentsForWorktree(otherWrite, worktreeId)).toBe(selected)
    expect(selectPaneForegroundAgentsForWorktree(otherWrite, 'missing')).toBe(
      EMPTY_PANE_FOREGROUND_AGENTS
    )
  })
})

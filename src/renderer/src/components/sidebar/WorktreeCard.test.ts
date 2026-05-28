import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
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
  }),
  isExplicitAgentStatusFresh: vi.fn(
    (entry: AgentStatusEntry, now: number, staleAfterMs: number) =>
      now - entry.updatedAt <= staleAfterMs
  )
}))

import { getWorktreeStatus } from '@/lib/worktree-status'
import { deriveWorktreeCardStatus } from './worktree-card-status'

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

function makeAgentStatusEntry(args: {
  paneKey: string
  state: AgentStatusEntry['state']
  updatedAt?: number
}): AgentStatusEntry {
  const updatedAt = args.updatedAt ?? 1_000
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt,
    stateStartedAt: updatedAt,
    stateHistory: []
  }
}

describe('getWorktreeStatus', () => {
  it('treats browser-only worktrees as active', () => {
    expect(getWorktreeStatus([], [{ id: 'browser-1' }], {})).toBe('active')
  })

  it('keeps terminal agent states higher priority than browser presence', () => {
    // Why: liveness gate now requires ptyIdsByTabId, not tab.ptyId. Pass a
    // populated live-pty map so this assertion exercises the live-tab branch.
    const livePtyIds = { 'tab-1': ['pty-1'] }
    expect(
      getWorktreeStatus([makeTerminalTab('permission needed')], [{ id: 'browser-1' }], livePtyIds)
    ).toBe('permission')
    expect(
      getWorktreeStatus([makeTerminalTab('working hard')], [{ id: 'browser-1' }], livePtyIds)
    ).toBe('working')
  })
})

describe('deriveWorktreeCardStatus', () => {
  it('keeps split-pane heuristics for panes without fresh explicit status', () => {
    const status = deriveWorktreeCardStatus({
      tabs: [makeTerminalTab('claude [done]')],
      browserTabs: [],
      worktreeAgentEntries: [makeAgentStatusEntry({ paneKey: 'tab-1:1', state: 'done' })],
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'claude [done]',
          2: 'codex [working]'
        }
      },
      now: 1_000
    })

    expect(status).toBe('working')
  })

  it('lets fresh explicit status win over the matching pane title heuristic', () => {
    const status = deriveWorktreeCardStatus({
      tabs: [makeTerminalTab('codex [working]')],
      browserTabs: [],
      worktreeAgentEntries: [makeAgentStatusEntry({ paneKey: 'tab-1:2', state: 'done' })],
      runtimePaneTitlesByTabId: {
        'tab-1': {
          2: 'codex [working]'
        }
      },
      now: 1_000
    })

    expect(status).toBe('done')
  })
})

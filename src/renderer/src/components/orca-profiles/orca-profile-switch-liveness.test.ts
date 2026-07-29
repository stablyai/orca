import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { BrowserWorkspace, TerminalTab } from '../../../../shared/types'
import {
  getOrcaProfileProjectLiveWorkSummary,
  getOrcaProfileSwitchLiveWorkSummary,
  type OrcaProfileSwitchLiveWorkState
} from './orca-profile-switch-liveness'

const NOW = 1_000_000

function makeState(
  overrides: Partial<OrcaProfileSwitchLiveWorkState> = {}
): OrcaProfileSwitchLiveWorkState {
  return {
    agentStatusByPaneKey: {},
    browserTabsByWorktree: {},
    ptyIdsByTabId: {},
    runtimePaneTitlesByTabId: {},
    tabsByWorktree: {},
    ...overrides
  }
}

function makeTab(
  overrides: Partial<Omit<TerminalTab, 'id' | 'worktreeId'>> & {
    id: string
    worktreeId?: string
  }
): TerminalTab {
  const { id, worktreeId = 'worktree-1', ...rest } = overrides
  return {
    id,
    color: null,
    createdAt: NOW,
    customTitle: null,
    ptyId: null,
    sortOrder: 0,
    title: 'zsh',
    worktreeId,
    ...rest
  }
}

function makeAgentEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:0',
    prompt: '',
    state: 'working',
    stateHistory: [],
    stateStartedAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function makeBrowserWorkspace(id: string): BrowserWorkspace {
  return {
    id,
    activePageId: null,
    canGoBack: false,
    canGoForward: false,
    createdAt: NOW,
    faviconUrl: null,
    label: 'Browser',
    loadError: null,
    loading: false,
    pageIds: [],
    title: 'Browser',
    url: 'about:blank',
    worktreeId: 'worktree-1'
  }
}

describe('getOrcaProfileSwitchLiveWorkSummary', () => {
  it('reports quiet profiles as safe to switch without confirmation', () => {
    expect(getOrcaProfileSwitchLiveWorkSummary(makeState(), NOW)).toEqual({
      browserWorkspaceCount: 0,
      hasLiveWork: false,
      liveAgentCount: 0,
      livePtyCount: 0,
      liveTerminalTabCount: 0
    })
  })

  it('counts live PTYs as live terminal work', () => {
    const summary = getOrcaProfileSwitchLiveWorkSummary(
      makeState({
        ptyIdsByTabId: {
          'tab-1': ['pty-1', 'pty-2'],
          'tab-2': []
        }
      }),
      NOW
    )

    expect(summary).toMatchObject({
      hasLiveWork: true,
      livePtyCount: 2,
      liveTerminalTabCount: 1
    })
  })

  it('counts fresh working explicit agent status', () => {
    const summary = getOrcaProfileSwitchLiveWorkSummary(
      makeState({
        agentStatusByPaneKey: {
          'tab-1:0': makeAgentEntry({ paneKey: 'tab-1:0', state: 'working' }),
          'tab-2:0': makeAgentEntry({ paneKey: 'tab-2:0', state: 'done' }),
          'tab-3:0': makeAgentEntry({
            paneKey: 'tab-3:0',
            state: 'waiting',
            updatedAt: -999_999_999
          })
        }
      }),
      NOW
    )

    expect(summary.liveAgentCount).toBe(1)
    expect(summary.hasLiveWork).toBe(true)
  })

  it('counts title-detected agents only when the tab has a live PTY', () => {
    const summary = getOrcaProfileSwitchLiveWorkSummary(
      makeState({
        ptyIdsByTabId: {
          'tab-live': ['pty-1']
        },
        tabsByWorktree: {
          'worktree-1': [
            makeTab({ id: 'tab-live', title: 'Codex working' }),
            makeTab({ id: 'tab-slept', title: 'Codex working' })
          ]
        }
      }),
      NOW
    )

    expect(summary.liveAgentCount).toBe(1)
    expect(summary.hasLiveWork).toBe(true)
  })

  it('counts browser workspaces as live browser work', () => {
    const summary = getOrcaProfileSwitchLiveWorkSummary(
      makeState({
        browserTabsByWorktree: {
          'worktree-1': [makeBrowserWorkspace('browser-1'), makeBrowserWorkspace('browser-2')]
        }
      }),
      NOW
    )

    expect(summary).toMatchObject({
      browserWorkspaceCount: 2,
      hasLiveWork: true
    })
  })

  it('filters live work to the selected project', () => {
    const summary = getOrcaProfileProjectLiveWorkSummary(
      makeState({
        agentStatusByPaneKey: {
          'other-tab:0': makeAgentEntry({
            paneKey: 'other-tab:0',
            worktreeId: 'repo-other::/workspace/other'
          })
        },
        browserTabsByWorktree: {
          'repo-1::/workspace/orca': [makeBrowserWorkspace('browser-1')],
          'repo-other::/workspace/other': [makeBrowserWorkspace('browser-2')]
        },
        ptyIdsByTabId: {
          'tab-live': ['pty-1'],
          'other-tab': ['pty-2']
        },
        tabsByWorktree: {
          'repo-1::/workspace/orca': [makeTab({ id: 'tab-live', title: 'Codex working' })],
          'repo-other::/workspace/other': [makeTab({ id: 'other-tab', title: 'Codex working' })]
        }
      }),
      'repo-1',
      NOW
    )

    expect(summary).toMatchObject({
      browserWorkspaceCount: 1,
      hasLiveWork: true,
      liveAgentCount: 1,
      livePtyCount: 1,
      liveTerminalTabCount: 1
    })
  })
})

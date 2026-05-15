import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'

type MockState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusEpoch: number
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, unknown>
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))

function makeTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: 'pty-1',
    title: 'bash',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeAgentStatusEntry(args: {
  paneKey: string
  state: AgentStatusEntry['state']
}): AgentStatusEntry {
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: []
  }
}

function StatusProbe({ worktreeId }: { worktreeId: string }) {
  return <span>{useWorktreeActivityStatus(worktreeId)}</span>
}

describe('useWorktreeActivityStatus', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    mockState = {
      tabsByWorktree: {},
      browserTabsByWorktree: {},
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {}
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a restored offscreen working agent yellow from the hook snapshot', () => {
    const worktreeId = 'repo1::/path/wt1'
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      agentStatusByPaneKey: {
        'tab-1:1': makeAgentStatusEntry({ paneKey: 'tab-1:1', state: 'working' })
      }
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe(
      '<span>working</span>'
    )
  })
})

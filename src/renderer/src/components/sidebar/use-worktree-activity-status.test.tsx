import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/types'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const THIRD_LEAF_ID = '33333333-3333-4333-8333-333333333333'

type MockState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusEpoch: number
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  runtimeAgentOrchestrationByPaneKey: Record<string, NonNullable<AgentStatusEntry['orchestration']>>
  migrationUnsupportedByPtyId: Record<string, never>
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
  worktreeId?: string
  parentPaneKey?: string
}): AgentStatusEntry {
  return {
    paneKey: args.paneKey,
    state: args.state,
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    stateHistory: [],
    worktreeId: args.worktreeId,
    orchestration: args.parentPaneKey
      ? {
          taskId: 'task-1',
          dispatchId: 'dispatch-1',
          parentPaneKey: args.parentPaneKey
        }
      : undefined
  }
}

function makeSplitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID },
      second: { type: 'leaf', leafId: SECOND_LEAF_ID }
    },
    activeLeafId: LEAF_ID,
    expandedLeafId: null
  }
}

function makeThreePaneLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID },
      second: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: SECOND_LEAF_ID },
        second: { type: 'leaf', leafId: THIRD_LEAF_ID }
      }
    },
    activeLeafId: LEAF_ID,
    expandedLeafId: null
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
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      agentStatusEpoch: 0,
      agentStatusByPaneKey: {},
      runtimeAgentOrchestrationByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      retainedAgentsByPaneKey: {}
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a restored offscreen working agent yellow from the hook snapshot', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'working' })
      }
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe(
      '<span>working</span>'
    )
  })

  it('lets a fresh hook done state override the same pane stale working title', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: '⠋ Codex',
          2: 'bash'
        }
      },
      terminalLayoutsByTabId: {
        'tab-1': makeSplitLayout()
      },
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'done' })
      }
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe('<span>done</span>')
  })

  it('lets a retained done row override the same pane stale working title', () => {
    const worktreeId = 'repo1::/path/wt1'
    const tab = makeTab('tab-1', worktreeId)
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [worktreeId]: [tab]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: '⠋ Codex',
          2: 'bash'
        }
      },
      terminalLayoutsByTabId: {
        'tab-1': makeSplitLayout()
      },
      retainedAgentsByPaneKey: {
        [paneKey]: {
          entry: makeAgentStatusEntry({ paneKey, state: 'done' }),
          worktreeId,
          tab,
          agentType: 'codex',
          startedAt: 1_000
        }
      }
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe('<span>done</span>')
  })

  it('does not keep the card working when all retained parent agents are done', () => {
    const worktreeId = 'repo1::/path/wt1'
    const tab = makeTab('tab-1', worktreeId)
    const paneKeys = [
      makePaneKey('tab-1', LEAF_ID),
      makePaneKey('tab-1', SECOND_LEAF_ID),
      makePaneKey('tab-1', THIRD_LEAF_ID)
    ]
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [worktreeId]: [tab]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: '⠋ Codex',
          2: '⠋ Codex',
          3: '⠋ Codex'
        }
      },
      terminalLayoutsByTabId: {
        'tab-1': makeThreePaneLayout()
      },
      retainedAgentsByPaneKey: Object.fromEntries(
        paneKeys.map((paneKey, index) => [
          paneKey,
          {
            entry: makeAgentStatusEntry({ paneKey, state: 'done' }),
            worktreeId,
            tab,
            agentType: 'codex',
            startedAt: 1_000 + index
          }
        ])
      )
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe('<span>done</span>')
  })

  it('lets a legacy numeric done hook override the matching stale working title', () => {
    const worktreeId = 'repo1::/path/wt1'
    const paneKey = 'tab-1:1'
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-1', worktreeId)]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: '⠋ Codex'
        }
      },
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [paneKey]: makeAgentStatusEntry({ paneKey, state: 'done' })
      }
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe('<span>done</span>')
  })

  it('lets a completed worker suppress its parent pane stale working title', () => {
    const worktreeId = 'repo1::/path/wt1'
    const parentPaneKey = makePaneKey('tab-parent', LEAF_ID)
    const childPaneKey = makePaneKey('tab-child', SECOND_LEAF_ID)
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [worktreeId]: [makeTab('tab-parent', worktreeId)]
      },
      ptyIdsByTabId: {
        'tab-parent': ['pty-parent']
      },
      runtimePaneTitlesByTabId: {
        'tab-parent': {
          1: '⠋ Codex'
        }
      },
      terminalLayoutsByTabId: {
        'tab-parent': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null
        }
      },
      agentStatusEpoch: 1,
      agentStatusByPaneKey: {
        [childPaneKey]: makeAgentStatusEntry({
          paneKey: childPaneKey,
          state: 'done',
          worktreeId,
          parentPaneKey
        })
      }
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe('<span>done</span>')
  })

  it('scopes cached agent summaries to the matching worktree', () => {
    const firstWorktreeId = 'repo1::/path/wt1'
    const secondWorktreeId = 'repo1::/path/wt2'
    const firstPaneKey = makePaneKey('tab-1', LEAF_ID)
    const retainedPaneKey = 'tab-2:0'
    const retainedTab = makeTab('tab-2', secondWorktreeId)
    mockState = {
      ...mockState,
      tabsByWorktree: {
        [firstWorktreeId]: [makeTab('tab-1', firstWorktreeId)],
        [secondWorktreeId]: [retainedTab]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-1'],
        'tab-2': []
      },
      agentStatusByPaneKey: {
        [firstPaneKey]: makeAgentStatusEntry({ paneKey: firstPaneKey, state: 'working' })
      },
      retainedAgentsByPaneKey: {
        [retainedPaneKey]: {
          entry: makeAgentStatusEntry({ paneKey: retainedPaneKey, state: 'done' }),
          worktreeId: secondWorktreeId,
          tab: retainedTab,
          agentType: 'claude',
          startedAt: 1_000
        }
      }
    }

    expect(renderToStaticMarkup(<StatusProbe worktreeId={firstWorktreeId} />)).toBe(
      '<span>working</span>'
    )
    expect(renderToStaticMarkup(<StatusProbe worktreeId={secondWorktreeId} />)).toBe(
      '<span>done</span>'
    )
  })
})

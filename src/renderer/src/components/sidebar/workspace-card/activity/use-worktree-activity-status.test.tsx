import {
  acceptedAgentStatuses,
  type AcceptedAgentStatuses
} from '@/store/slices/agent-status/accepted-agent-statuses'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

import type { Tab } from '../../../../../../shared/tab-types'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import type {
  TerminalLayoutSnapshot,
  TerminalTab
} from '../../../../../../shared/workspace-layout/terminal-tab-types'
import { toRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useWorktreeActivityStatus } from './use-worktree-activity-status'
import { useWorktreeActivityStatuses } from './use-worktree-activity-statuses'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF_ID = '22222222-2222-4222-8222-222222222222'

type MockState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  browserTabsByWorktree: Record<string, { id: string }[]>
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  ptyIdsByTabId: Record<string, string[]>
  agentStatusEpoch: number
  agentStatusByPaneKey: AcceptedAgentStatuses
  runtimeAgentOrchestrationByPaneKey: Record<string, NonNullable<AgentStatusEntry['orchestration']>>
  migrationUnsupportedByPtyId: Record<string, never>
  unifiedTabsByWorktree: Record<string, Tab[]>
  structuredChatSleptAtByPaneKey: Record<string, number | null>
  wslHostStatuses?: Record<string, { state: string; distro: string }>
}

let mockState: MockState

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: MockState) => unknown) => selector(mockState)
}))
vi.mock('@/lib/workspace/ownership/workspace-runtime-environment', () => ({
  selectWorkspaceRuntimeEnvironmentId: () => 'wsl:ubuntu'
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

function StatusProbe({ worktreeId }: { worktreeId: string }) {
  return <span>{useWorktreeActivityStatus(worktreeId)}</span>
}

function StatusesProbe({ worktreeId }: { worktreeId: string }) {
  return <span>{useWorktreeActivityStatuses([worktreeId]).get(worktreeId)}</span>
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
      agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
      runtimeAgentOrchestrationByPaneKey: {},
      migrationUnsupportedByPtyId: {},

      unifiedTabsByWorktree: {},
      structuredChatSleptAtByPaneKey: {}
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // verify-7: a terminal on a terminated distro kept the workspace's green dot.
  it('shows a workspace on a stopped WSL host as inactive, though its panes keep their bindings', () => {
    const worktreeId = 'repo1::/home/u/app'
    mockState = {
      ...mockState,
      tabsByWorktree: { [worktreeId]: [makeTab('tab-1', worktreeId)] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      wslHostStatuses: { 'wsl:debian': { state: 'distro-stopped', distro: 'Debian' } }
    }
    // Another distro's stop is not this workspace's.
    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe(
      '<span>active</span>'
    )
    expect(renderToStaticMarkup(<StatusesProbe worktreeId={worktreeId} />)).toBe(
      '<span>active</span>'
    )
    mockState = {
      ...mockState,
      wslHostStatuses: { 'wsl:ubuntu': { state: 'distro-stopped', distro: 'Ubuntu' } }
    }
    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe(
      '<span>inactive</span>'
    )
    expect(renderToStaticMarkup(<StatusesProbe worktreeId={worktreeId} />)).toBe(
      '<span>inactive</span>'
    )

    // e9-reviewer: a pane bound to another, running server is the card's exception too.
    mockState = {
      ...mockState,
      ptyIdsByTabId: { 'tab-1': [toRemoteRuntimePtyId('h1', 'ssh:desk')] }
    }
    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe(
      '<span>active</span>'
    )
    expect(renderToStaticMarkup(<StatusesProbe worktreeId={worktreeId} />)).toBe(
      '<span>active</span>'
    )
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
      agentStatusByPaneKey: acceptedAgentStatuses(
        Object.entries({
          [childPaneKey]: makeAgentStatusEntry({
            paneKey: childPaneKey,
            state: 'done',
            worktreeId,
            parentPaneKey
          })
        })
      )
    }

    const store = createTestStore()
    store.setState({
      tabsByWorktree: mockState.tabsByWorktree,
      ptyIdsByTabId: mockState.ptyIdsByTabId,
      runtimePaneTitlesByTabId: mockState.runtimePaneTitlesByTabId,
      terminalLayoutsByTabId: mockState.terminalLayoutsByTabId,
      agentStatusByPaneKey: mockState.agentStatusByPaneKey
    })
    mockState = store.getState()
    expect(renderToStaticMarkup(<StatusProbe worktreeId={worktreeId} />)).toBe('<span>done</span>')
  })
})

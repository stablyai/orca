import { describe, expect, it } from 'vitest'

import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { DashboardCard } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'

const card: DashboardCard = {
  paneKey: 'pane-1',
  ptyId: null,
  agentType: 'claude',
  bucket: 'working',
  dotState: 'working',
  task: 'ship the fix',
  repoId: 'repo-1',
  worktreeId: 'wt-1',
  tabId: 'tab-1',
  leafId: null,
  repoName: 'orca',
  worktreeName: 'main',
  hostKind: 'local',
  executionHostId: 'local',
  workspaceKind: 'worktree',
  subagents: [
    { id: 'pane-1\u0000subagent:a1', name: 'sdlc:engineer', dotState: 'working' },
    { id: 'pane-1\u0000subagent:a2', name: 'coordinator', dotState: 'working' }
  ],
  startedAt: 1_000,
  finishedAt: null,
  stateChangedAt: 1_000,
  statusUpdatedAt: 2_000,
  unseen: false
}

const status: AgentStatusIpcPayload = {
  paneKey: 'pane-1',
  worktreeId: 'wt-1',
  agentType: 'claude',
  state: 'working',
  prompt: 'ship the fix',
  connectionId: null,
  receivedAt: 3_000,
  stateStartedAt: 1_000
}

describe('patchDashboardSnapshotFromAgentStatus', () => {
  it('drops subagent rows when the status no longer lists any', () => {
    const result = patchDashboardSnapshotFromAgentStatus(
      { generatedAt: 2_000, cards: [card] },
      status
    )

    expect(result.snapshot.cards[0]?.subagents).toBeUndefined()
  })
})

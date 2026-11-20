import { expect, it } from 'vitest'
import type { DashboardSnapshot } from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { AgentStatusIpcPayload } from '../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { patchDashboardSnapshotFromAgentStatus } from './dashboard-agent-status-patch'

const snapshot: DashboardSnapshot = {
  generatedAt: 3_000,
  cards: [
    {
      paneKey: 'pane',
      ptyId: null,
      agentType: 'codex',
      bucket: 'working',
      dotState: 'working',
      task: '',
      repoId: 'repo',
      worktreeId: 'workspace',
      tabId: 'tab',
      leafId: null,
      repoName: '',
      worktreeName: '',
      startedAt: 1_000,
      finishedAt: 1_000,
      stateChangedAt: 3_000,
      statusUpdatedAt: 3_000,
      acknowledgedAt: 2_000,
      unseen: true
    }
  ]
}
const boundary: AgentStatusIpcPayload = {
  paneKey: 'pane',
  connectionId: null,
  state: 'done',
  prompt: '',
  sessionBoundary: true,
  stateStartedAt: 5_000,
  receivedAt: 5_000,
  lastCompletionAt: 1_000
}

it('shows the retained result as read when a boundary replaces work, then shows an equal-clock real result unread', () => {
  const idle = patchDashboardSnapshotFromAgentStatus(snapshot, boundary).snapshot
  expect(idle.cards[0]).toMatchObject({ unseen: false, bucket: 'idle', finishedAt: 1_000 })
  const done = patchDashboardSnapshotFromAgentStatus(idle, {
    ...boundary,
    sessionBoundary: false,
    receivedAt: 9_000,
    lastAssistantMessage: 'New result'
  }).snapshot
  expect(done.cards[0]).toMatchObject({
    unseen: true,
    bucket: 'done',
    finishedAt: 9_000,
    lastAgentMessage: 'New result'
  })
})

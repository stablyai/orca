import { defineFixture } from '../../component-fixtures/component-fixture'
import WorktreeCardAgents from './WorktreeCardAgents'
import { applyAgentRowLineage } from '../dashboard/agent-row-lineage'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

const now = 1_792_983_600_000
const tabs: Tab[] = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
].map((entityId, index) => ({
  id: index === 0 ? 'reserved-chat-tab' : 'worker-chat-tab:history-1',
  entityId,
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  worktreeId: 'fixture-workspace',
  groupId: 'fixture-group',
  executionHostId: 'local',
  label: 'Chat',
  customLabel: null,
  color: null,
  sortOrder: index,
  createdAt: now
}))
const [parent, child] = tabs.map((tab) => structuredAgentSessionPaneKey(tab.id, tab.entityId))
const entries: AgentStatusEntry[] = [parent, child].map((paneKey, index) => ({
  paneKey,
  worktreeId: 'fixture-workspace',
  agentType: 'codex',
  state: 'working',
  prompt: index === 0 ? 'Coordinate the release checks' : 'Verify the worker result',
  updatedAt: now,
  stateStartedAt: now,
  stateHistory: [],
  ...(index === 1
    ? { orchestration: { taskId: 'task', dispatchId: 'dispatch', parentPaneKey: parent } }
    : {})
}))
const rows = applyAgentRowLineage(
  buildWorktreeAgentRows({
    tabs: [],
    representedTabs: new Map(
      tabs.map((tab) => [structuredAgentSessionPaneKey(tab.id, tab.entityId), tab])
    ),
    entries,
    retained: [],
    now
  })
)

export const nestedChatWorker = defineFixture({
  width: 380,
  store: { agentActivityDisplayMode: 'compact' },
  render: () => (
    <div className="flex flex-col gap-0.5 bg-sidebar p-2 text-sidebar-foreground">
      <WorktreeCardAgents worktreeId="fixture-workspace" agents={rows} />
    </div>
  )
})

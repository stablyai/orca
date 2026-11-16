import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import WorktreeCardAgents from './WorktreeCardAgents'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/tab-types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'

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
export const nestedChatWorker = defineFixture({
  width: 380,
  store: {
    agentActivityDisplayMode: 'compact',
    unifiedTabsByWorktree: { 'fixture-workspace': tabs },
    agentStatusByPaneKey: acceptedAgentStatuses(entries.map((entry) => [entry.paneKey, entry]))
  },
  render: () => (
    <div className="flex flex-col gap-0.5 bg-sidebar p-2 text-sidebar-foreground">
      <WorktreeCardAgents worktreeId="fixture-workspace" />
    </div>
  )
})

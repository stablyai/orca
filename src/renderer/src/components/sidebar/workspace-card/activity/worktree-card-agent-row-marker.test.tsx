// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { WORKSPACE_AGENT_ROW_ATTR } from '../../workspace-actions/context-menu/workspace-agent-row-marker'
import WorktreeCardAgents from './WorktreeCardAgents'

// Fixed, so no test reads the wall clock.
const now = 1_792_983_600_000
const tabs: Tab[] = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222'
].map((entityId, index) => ({
  id: index === 0 ? 'reserved-chat-tab' : 'worker-chat-tab:history-1',
  entityId,
  contentType: 'agent-session',
  agentSessionAgent: 'codex',
  worktreeId: 'marker-workspace',
  groupId: 'marker-group',
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
  worktreeId: 'marker-workspace',
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

function renderAgents(mode: 'compact' | 'full'): HTMLElement {
  useAppStore.setState({
    agentActivityDisplayMode: mode,
    unifiedTabsByWorktree: { 'marker-workspace': tabs },
    agentStatusByPaneKey: acceptedAgentStatuses(entries.map((entry) => [entry.paneKey, entry]))
  })
  return render(
    <TooltipProvider>
      <WorktreeCardAgents worktreeId="marker-workspace" />
    </TooltipProvider>
  ).container
}

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('agent rows in a workspace card', () => {
  it.each(['compact', 'full'] as const)(
    'mark each %s row, so its right-click leaves Delete out of the workspace menu',
    (mode) => {
      const container = renderAgents(mode)
      const rows = container.querySelectorAll('.agent-disclosure-row')
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) {
        expect(row.getAttribute(WORKSPACE_AGENT_ROW_ATTR)).toBe('true')
      }
    }
  )
})

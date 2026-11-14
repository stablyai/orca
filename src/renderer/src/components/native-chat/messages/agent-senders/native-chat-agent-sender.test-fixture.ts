import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { OrcaSessionId } from '../../../../../../shared/orca-session-address'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { makeUnifiedTab } from '@/store/slices/tabs/tab-group.test-fixture'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentMessageSource } from '../../../../../../shared/agent-session/agent-session-message-source'

export const initialStore = useAppStore.getState()
export const LEAF = '11111111-1111-4111-8111-111111111111'
export function status(i: number, worktreeId = 'workspace'): AgentStatusEntry {
  return {
    paneKey: `tab-${i}:${LEAF}`,
    worktreeId,
    terminalHandle: `term_${i}`,
    agentType: 'claude',
    state: 'working',
    prompt: 'work',
    updatedAt: 2_000_000,
    stateStartedAt: 2_000_000,
    stateHistory: []
  }
}
export const from: AgentMessageSource = {
  kind: 'agent',
  orchestration: null,
  senders: ['Build cards', 'Other sender'].map((name, i) => ({
    name,
    party: { address: `term_${i}`, terminalHandle: `term_${i}`, orcaSessionId: null }
  }))
}

export function resetSenderStore(): void {
  useAppStore.setState(
    {
      ...initialStore,
      activeWorktreeId: 'workspace',
      activeWorkspaceExecutionHostId: 'local',
      tabsByWorktree: { workspace: [makeTab({ id: 'tab-0', worktreeId: 'workspace' })] },
      unifiedTabsByWorktree: {},
      agentStatusByPaneKey: { [status(0).paneKey]: status(0) },

      migrationUnsupportedByPtyId: {},
      runtimeAgentOrchestrationByPaneKey: {},
      runtimePaneTitlesByTabId: {},
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      paneForegroundAgentByPaneKey: {},
      agentStatusEpoch: 1
    },
    true
  )
}

export function setSenderSessionStatus(sessionId: OrcaSessionId): AgentStatusEntry {
  const tab = makeUnifiedTab({
    id: 'progress-chat',
    entityId: sessionId,
    worktreeId: 'workspace',
    groupId: 'g',
    contentType: 'agent-session',
    executionHostId: 'local',
    agentSessionAgent: 'claude'
  })
  const paneKey = structuredAgentSessionPaneKey(tab.id, sessionId)
  const entry: AgentStatusEntry = {
    ...status(0),
    paneKey,
    programStatus: { state: 'working', progress: 40, observedAt: 2_000_000 }
  }
  useAppStore.setState({
    unifiedTabsByWorktree: { workspace: [tab] },
    agentStatusByPaneKey: { [paneKey]: entry }
  })
  return entry
}

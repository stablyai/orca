import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AppState } from '../../../store/types'

export function makeState(overrides: Partial<AppState> = {}): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: graph tests exercise only the snapshot fields defined here; no omitted actions are invoked.
  return {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {},
    tabBarOrderByWorktree: {},
    activeFileId: null,
    activeFileIdByWorktree: {},
    activeTabType: 'terminal',
    activeTabTypeByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    browserCertificateFailuresByPageId: {},
    openFiles: [],
    editorDrafts: {},
    activeTabId: null,
    agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
    agentStatusEpoch: 0,
    ...overrides
  } as AppState
}

export function makeAgentStatusEntry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'fix parity',
    updatedAt: 1_700_000_000_000,
    stateStartedAt: 1_699_999_999_000,
    agentType: 'codex',
    paneKey: 'term-1:11111111-1111-4111-8111-111111111111',
    terminalTitle: 'codex [working]',
    stateHistory: [],
    ...overrides
  }
}

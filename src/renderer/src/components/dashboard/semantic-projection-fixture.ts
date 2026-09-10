import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { DashboardSnapshotState } from './build-dashboard-snapshot'

export const PROJECTION_NOW = 1_000_000_000
export const PROJECTION_LEAF = '11111111-1111-4111-8111-111111111111'
export const PROJECTION_PANE = `semantic-tab:${PROJECTION_LEAF}`

export function semanticProjectionEntry(
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    paneKey: PROJECTION_PANE,
    tabId: 'semantic-tab',
    worktreeId: 'semantic-workspace',
    agentType: 'codex',
    state: 'done',
    interrupted: true,
    prompt: 'Synthetic semantic projection task',
    updatedAt: PROJECTION_NOW,
    stateStartedAt: PROJECTION_NOW - 100,
    stateHistory: [],
    ...overrides
  }
}

export function semanticProjectionState(
  entry: AgentStatusEntry,
  seen = false
): DashboardSnapshotState {
  return {
    repos: [{ id: 'semantic-repo', path: '/synthetic', displayName: 'Synthetic project' }],
    worktreesByRepo: {
      'semantic-repo': [
        {
          id: 'semantic-workspace',
          repoId: 'semantic-repo',
          path: '/synthetic/folder',
          branch: '',
          head: '',
          displayName: 'Synthetic folder',
          isArchived: false,
          sortOrder: 0
        }
      ]
    },
    tabsByWorktree: {
      'semantic-workspace': [
        {
          id: 'semantic-tab',
          worktreeId: 'semantic-workspace',
          ptyId: 'synthetic-pty',
          title: 'Codex',
          createdAt: PROJECTION_NOW - 1000
        }
      ]
    },
    agentStatusByPaneKey: { [entry.paneKey]: entry },
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    terminalLayoutsByTabId: {
      'semantic-tab': {
        root: { type: 'leaf', leafId: PROJECTION_LEAF },
        activeLeafId: PROJECTION_LEAF,
        ptyIdsByLeafId: { [PROJECTION_LEAF]: 'synthetic-pty' }
      }
    },
    ptyIdsByTabId: { 'semantic-tab': ['synthetic-pty'] },
    runtimePaneTitlesByTabId: {},
    acknowledgedAgentsByPaneKey: seen ? { [entry.paneKey]: PROJECTION_NOW } : {}
  } as unknown as DashboardSnapshotState
}

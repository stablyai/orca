import type { DashboardSnapshotInput } from './build-dashboard-snapshot'
import type { PaneForegroundAgentEvidence } from '@/store/slices/pane-foreground-agent'
import { makePaneKey } from '../../../../shared/stable-pane-id'

export const FOREGROUND_TEST_NOW = 2_000_000
export const FOREGROUND_TEST_LEAF = '11111111-1111-4111-8111-111111111111'
export const FOREGROUND_TEST_KEY = makePaneKey('tab-neutral', FOREGROUND_TEST_LEAF)
export const FOREGROUND_TEST_WORKTREE = 'repo1::/wt-neutral'
export function foregroundConsumerState(
  evidence: PaneForegroundAgentEvidence | null
): DashboardSnapshotInput {
  const doneKey = makePaneKey('tab-done', FOREGROUND_TEST_LEAF)
  const tabs = ['neutral', 'done', 'title'].map((name) => ({
    id: `tab-${name}`,
    worktreeId: FOREGROUND_TEST_WORKTREE,
    ptyId: `pty-${name}`,
    title: name === 'title' ? '⠋ Claude' : 'project',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }))
  return {
    chatNames: new Map(),
    retainedAgentsByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimeAgentOrchestrationByPaneKey: {},
    acknowledgedAgentsByPaneKey: {},
    settings: null,
    repos: [{ id: 'repo1', path: '/wt', displayName: 'Repo', badgeColor: '#000000', addedAt: 0 }],
    worktreesByRepo: {
      repo1: [
        {
          id: FOREGROUND_TEST_WORKTREE,
          path: '/wt-neutral',
          repoId: 'repo1',
          head: 'abc',
          branch: 'main',
          isBare: false,
          isMainWorktree: false,
          displayName: 'Workspace',
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0
        }
      ]
    },
    tabsByWorktree: { [FOREGROUND_TEST_WORKTREE]: tabs },
    unifiedTabsByWorktree: {
      [FOREGROUND_TEST_WORKTREE]: tabs.map((tab) => ({
        id: `unified-${tab.id}`,
        entityId: tab.id,
        worktreeId: FOREGROUND_TEST_WORKTREE,
        contentType: 'terminal',
        executionHostId: 'local',
        groupId: 'group',
        label: tab.title,
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 0
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      tabs.map((tab) => [
        tab.id,
        {
          root: { type: 'leaf' as const, leafId: FOREGROUND_TEST_LEAF },
          activeLeafId: FOREGROUND_TEST_LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [FOREGROUND_TEST_LEAF]: tab.ptyId }
        }
      ])
    ),
    ptyIdsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id, [tab.ptyId]])),
    runtimePaneTitlesByTabId: {
      'tab-neutral': { 0: 'project' },
      'tab-done': { 0: 'project' },
      'tab-title': { 0: '⠋ Claude' }
    },
    agentStatusByPaneKey: {
      [doneKey]: {
        paneKey: doneKey,
        tabId: 'tab-done',
        worktreeId: FOREGROUND_TEST_WORKTREE,
        connectionId: null,
        agentType: 'claude' as const,
        state: 'done' as const,
        prompt: 'independent completed task',
        updatedAt: FOREGROUND_TEST_NOW,
        stateStartedAt: FOREGROUND_TEST_NOW,
        stateHistory: []
      }
    },
    paneForegroundAgentByPaneKey: evidence
      ? {
          [FOREGROUND_TEST_KEY]: {
            agent: 'codex' as const,
            agentEvidence: evidence,
            shellForeground: false,
            context: {
              execution: { privateExecutionSentinel: true },
              ptyId: 'pty-neutral',
              incarnationId: 'inc',
              endpoint: 'local',
              executionHost: 'local',
              worktreeId: FOREGROUND_TEST_WORKTREE,
              environmentId: null
            }
          }
        }
      : {}
  }
}

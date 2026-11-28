/** A live Dispatch on an open pane must block cleanup even when its status row has gone idle: a data-loss guard. */
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { AgentStatusOrchestrationContext } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { acceptedAgentStatuses } from '../agent-status/status-ownership/accepted-agent-statuses'
import { createTestStore, seedStore } from '../../testing/app-store-test-fixture'
import { makeTab } from '../../terminals/testing/terminal-tab.test-fixture'
import { makeUnifiedTab } from '../tabs/tab-group.test-fixture'
import type { AppState } from '../../types'
import {
  assertWorkspaceCleanupAgentStopApproved,
  getWorkspaceCleanupAgentEvidence
} from './workspace-cleanup-agent-evidence'

const WORKTREE_ID = 'repo1::/work/wt-a'
const TAB_ID = 'tab-a'
const PANE_KEY = makePaneKey(TAB_ID, '11111111-1111-4111-8111-111111111111')
const STALE_AT = 1_700_000_000_000

function candidate(): WorkspaceCleanupCandidate {
  return {
    worktreeId: WORKTREE_ID,
    repoId: 'repo1',
    repoName: 'Repo 1',
    connectionId: null,
    executionHostId: 'local',
    displayName: 'wt-a',
    branch: 'old',
    path: '/work/wt-a',
    reasons: ['inactive'],
    blockers: [],
    lastActivityAt: STALE_AT,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: STALE_AT },
    fingerprint: 'fp-a'
  }
}

function stateFor(
  options: {
    dispatchStatus?: AgentStatusOrchestrationContext['dispatchStatus'] | null
    entryAt?: number | null
    host?: ExecutionHostId
  } = {}
): AppState {
  const store = createTestStore()
  const host = options.host ?? 'local'
  const entryAt = options.entryAt ?? null
  const dispatchStatus =
    options.dispatchStatus === undefined ? 'dispatched' : options.dispatchStatus
  seedStore(store, {
    tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })] },
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: [
        makeUnifiedTab({
          id: TAB_ID,
          worktreeId: WORKTREE_ID,
          groupId: 'group-a',
          executionHostId: host
        })
      ]
    },
    agentStatusByPaneKey: acceptedAgentStatuses(
      entryAt === null
        ? []
        : [
            [
              PANE_KEY,
              {
                paneKey: PANE_KEY,
                state: 'working',
                connectionId: null,
                prompt: '',
                updatedAt: entryAt,
                stateStartedAt: entryAt,
                stateHistory: []
              }
            ] as const
          ]
    ),
    runtimeAgentOrchestrationByPaneKey: dispatchStatus
      ? {
          [PANE_KEY]: {
            taskId: 'task-a',
            dispatchId: 'dispatch-a',
            dispatchStatus
          }
        }
      : {}
  })
  return store.getState()
}

function statusOf(state: AppState): string | undefined {
  return getWorkspaceCleanupAgentEvidence(state, [candidate()]).get(
    getWorkspaceCleanupCandidateIdentity(candidate())
  )?.status
}

describe('workspace cleanup stop approval for active Dispatches', () => {
  it('treats an active Dispatch on a live pane as live even with no status row', () => {
    const state = stateFor()
    expect(statusOf(state)).toBe('live')
    expect(() => assertWorkspaceCleanupAgentStopApproved(state, candidate(), undefined)).toThrow()
  })

  it('treats an active Dispatch as live when the status row has decayed', () => {
    expect(statusOf(stateFor({ entryAt: STALE_AT }))).toBe('live')
    expect(statusOf(stateFor({ entryAt: STALE_AT, dispatchStatus: null }))).not.toBe('live')
  })

  it('does not attribute another host’s active Dispatch to this workspace', () => {
    const state = stateFor({ host: 'ssh:other' })
    expect(statusOf(state)).not.toBe('live')
    expect(() =>
      assertWorkspaceCleanupAgentStopApproved(state, candidate(), undefined)
    ).not.toThrow()
  })

  it('does not treat a settled Dispatch as live', () => {
    expect(statusOf(stateFor({ dispatchStatus: 'completed' }))).not.toBe('live')
  })
})

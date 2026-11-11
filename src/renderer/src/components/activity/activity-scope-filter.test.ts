import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'

import { filterThreadsByActivityScope } from './activity-scope-filter'
import type { ActivityScopeFilter } from './activity-scope-filter'
import type { AgentPaneThread } from './activity-thread-types'
import {
  makeRepo,
  makeTabWithIds,
  makeWorktree,
  PANE_KEY,
  makeWorkingEntryWithoutHistory,
  PANE_KEY_2,
  PANE_KEY_3
} from './ActivityPrototypePage-test-fixtures'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { collectHiddenChildAgentPaneKeys } from './activity-thread-child-agent'

{
  const SSH_HOST = 'ssh:devbox' as ExecutionHostId

  function makeThread(overrides: Partial<AgentPaneThread> = {}): AgentPaneThread {
    const worktree = makeWorktree()
    return {
      paneKey: PANE_KEY,
      paneTitle: 'Test Agent',
      agentType: 'claude',
      worktree,
      repo: makeRepo(),
      tab: makeTabWithIds('tab-1', worktree.id),
      events: [],
      latestEvent: null,
      latestTimestamp: 1000,
      currentAgentState: 'working',
      currentAgentEntry: null,
      unread: false,
      responsePreview: '',
      ...overrides
    }
  }

  function makeScope(overrides: Partial<ActivityScopeFilter> = {}): ActivityScopeFilter {
    return {
      visibleHostIds: null,
      filterRepoIds: [],
      defaultHostId: LOCAL_EXECUTION_HOST_ID,
      hideWorkspacesFromOtherDevices: false,
      pairedDeviceIdsByEnvironment: new Map(),
      hideAutomationGeneratedWorkspaces: false,
      hideCliCreatedWorkspaces: false,
      ...overrides
    }
  }

  describe('filterThreadsByActivityScope', () => {
    it('hides scoped-out threads but keeps the exempt pane, counting only real hides', () => {
      const local = makeThread()
      const remote = makeThread({
        paneKey: 'pane-remote',
        worktree: { ...makeWorktree(), hostId: SSH_HOST }
      })
      const exemptRemote = makeThread({
        paneKey: 'pane-exempt',
        worktree: { ...makeWorktree(), hostId: SSH_HOST }
      })
      const result = filterThreadsByActivityScope({
        threads: [local, remote, exemptRemote],
        scope: makeScope({ visibleHostIds: [LOCAL_EXECUTION_HOST_ID] }),
        exemptPaneKey: 'pane-exempt'
      })
      expect(result.threads).toEqual([local, exemptRemote])
      expect(result.matchingThreads).toEqual([local])
      expect(result.hiddenCount).toBe(1)
    })
  })
}

{
  function makeTestEntry(
    paneKey: string,
    overrides: Partial<AgentStatusEntry> = {}
  ): AgentStatusEntry {
    return {
      ...makeWorkingEntryWithoutHistory(),
      paneKey,
      state: 'done',
      prompt: 'test prompt',
      stateHistory: [],
      ...overrides
    }
  }

  function makeTestThread(
    paneKey: string,
    overrides: Partial<AgentPaneThread> = {}
  ): AgentPaneThread {
    const worktree = makeWorktree()
    return {
      paneKey,
      paneTitle: 'Test Agent',
      agentType: 'claude',
      worktree,
      repo: makeRepo(),
      tab: makeTabWithIds('tab-1', worktree.id),
      events: [],
      latestEvent: null,
      latestTimestamp: 1000,
      currentAgentState: 'working',
      currentAgentEntry: makeTestEntry(paneKey),
      unread: false,
      responsePreview: '',
      ...overrides
    }
  }

  describe('collectHiddenChildAgentPaneKeys', () => {
    it('keeps a live worker listed after its coordinator ends its turn', () => {
      const workerOf = (paneKey: string, overrides: Partial<AgentPaneThread>) =>
        makeTestThread(paneKey, {
          currentAgentEntry: makeTestEntry(paneKey, {
            orchestration: { parentPaneKey: PANE_KEY, taskId: paneKey, dispatchId: paneKey }
          }),
          ...overrides
        })
      const coordinator = makeTestThread(PANE_KEY, { currentAgentState: null })
      const working = workerOf(PANE_KEY_2, { currentAgentState: 'working' })
      const finished = workerOf(PANE_KEY_3, { currentAgentState: null })
      expect(collectHiddenChildAgentPaneKeys([coordinator, working, finished])).toEqual(
        new Set([PANE_KEY_3])
      )
    })
  })
}

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import {
  filterThreadsByActivityScope,
  resolveActivityScopeRepoIds,
  threadMatchesActivityScope
} from './activity-scope-filter'
import type { ActivityScopeFilter } from './activity-scope-filter'
import type { AgentPaneThread, ActivityEvent, ActivityThreadGroup } from './activity-thread-types'
import {
  makeRepo,
  makeTabWithIds,
  makeWorktree,
  PANE_KEY,
  makeWorkingEntryWithoutHistory,
  PANE_KEY_2,
  PANE_KEY_3,
  makeTab
} from './ActivityPrototypePage-test-fixtures'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { collectChildAgentPaneKeys } from './activity-thread-child-agent'
import {
  buildActivityVirtualItems,
  findActivityThreadItemIndex,
  getActivityHeaderItemIndexes,
  getActivityVirtualItemKey
} from './activity-thread-virtual-items'

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

  describe('threadMatchesActivityScope', () => {
    it('matches everything when no scope is active', () => {
      expect(threadMatchesActivityScope(makeThread(), makeScope())).toBe(true)
      expect(threadMatchesActivityScope(makeThread({ repo: null }), makeScope())).toBe(true)
    })

    it('filters by execution host, falling back to the default host for local worktrees', () => {
      const local = makeThread()
      const remote = makeThread({
        worktree: { ...makeWorktree(), hostId: SSH_HOST }
      })
      const localOnly = makeScope({ visibleHostIds: [LOCAL_EXECUTION_HOST_ID] })
      expect(threadMatchesActivityScope(local, localOnly)).toBe(true)
      expect(threadMatchesActivityScope(remote, localOnly)).toBe(false)
      const remoteOnly = makeScope({ visibleHostIds: [SSH_HOST] })
      expect(threadMatchesActivityScope(local, remoteOnly)).toBe(false)
      expect(threadMatchesActivityScope(remote, remoteOnly)).toBe(true)
    })

    it('filters by project and hides repo-less threads under a project scope', () => {
      const scope = makeScope({ filterRepoIds: ['repo-1'] })
      expect(threadMatchesActivityScope(makeThread(), scope)).toBe(true)
      expect(
        threadMatchesActivityScope(makeThread({ repo: { ...makeRepo(), id: 'repo-2' } }), scope)
      ).toBe(false)
      expect(threadMatchesActivityScope(makeThread({ repo: null }), scope)).toBe(false)
    })
  })

  describe('threadMatchesActivityScope workspace-origin toggles', () => {
    const cliThread = makeThread({
      worktree: { ...makeWorktree(), cliProvenance: { kind: 'created-by-cli', createdAt: 1 } }
    })
    const otherDeviceThread = makeThread({
      worktree: {
        ...makeWorktree(),
        runtimeOwnerEnvironmentId: 'env-1',
        creatorProvenance: { kind: 'paired-device', deviceId: 'phone' }
      }
    })
    const ownDeviceThread = makeThread({
      worktree: {
        ...makeWorktree(),
        runtimeOwnerEnvironmentId: 'env-1',
        creatorProvenance: { kind: 'paired-device', deviceId: 'this-desktop' }
      }
    })
    const pairedDeviceIdsByEnvironment = new Map([['env-1', 'this-desktop']])

    it('hides CLI-created workspaces only when that toggle is on', () => {
      expect(threadMatchesActivityScope(cliThread, makeScope())).toBe(true)
      expect(
        threadMatchesActivityScope(cliThread, makeScope({ hideCliCreatedWorkspaces: true }))
      ).toBe(false)
      expect(
        threadMatchesActivityScope(
          cliThread,
          makeScope({ hideAutomationGeneratedWorkspaces: true })
        )
      ).toBe(true)
    })

    it('hides workspaces created from another client of the same runtime', () => {
      const scope = makeScope({
        hideWorkspacesFromOtherDevices: true,
        pairedDeviceIdsByEnvironment
      })
      expect(threadMatchesActivityScope(otherDeviceThread, scope)).toBe(false)
      expect(threadMatchesActivityScope(ownDeviceThread, scope)).toBe(true)
    })

    it('never hides provenance-less threads such as floating terminals', () => {
      const floating = makeThread({ repo: null })
      const scope = makeScope({
        hideWorkspacesFromOtherDevices: true,
        pairedDeviceIdsByEnvironment,
        hideAutomationGeneratedWorkspaces: true,
        hideCliCreatedWorkspaces: true
      })
      expect(threadMatchesActivityScope(floating, scope)).toBe(true)
    })

    it('keeps the exempt pane visible and counts the rest as hidden', () => {
      const plain = makeThread({ paneKey: 'pane-plain' })
      const exemptCli = { ...cliThread, paneKey: 'pane-exempt' }
      const result = filterThreadsByActivityScope({
        threads: [plain, cliThread, exemptCli],
        scope: makeScope({ hideCliCreatedWorkspaces: true }),
        exemptPaneKey: 'pane-exempt'
      })
      expect(result.threads).toEqual([plain, exemptCli])
      expect(result.matchingThreads).toEqual([plain])
      expect(result.hiddenCount).toBe(1)
    })
  })

  describe('filterThreadsByActivityScope', () => {
    it('returns the input array by identity when the scope is inactive', () => {
      const threads = [makeThread(), makeThread({ paneKey: 'pane-2', repo: null })]
      const result = filterThreadsByActivityScope({
        threads,
        scope: makeScope(),
        exemptPaneKey: null
      })
      expect(result.threads).toBe(threads)
      expect(result.matchingThreads).toBe(threads)
      expect(result.hiddenCount).toBe(0)
    })

    it('returns the input array by identity when an active scope hides nothing', () => {
      const threads = [makeThread()]
      const result = filterThreadsByActivityScope({
        threads,
        scope: makeScope({ visibleHostIds: [LOCAL_EXECUTION_HOST_ID] }),
        exemptPaneKey: null
      })
      expect(result.threads).toBe(threads)
      expect(result.matchingThreads).toBe(threads)
      expect(result.hiddenCount).toBe(0)
    })

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

  describe('resolveActivityScopeRepoIds', () => {
    it('drops stale repo ids so they cannot count as an active filter', () => {
      const repoMap = new Map<string, Repo>([['repo-1', makeRepo()]])
      expect(resolveActivityScopeRepoIds(['repo-1', 'gone-repo'], repoMap)).toEqual(['repo-1'])
      expect(resolveActivityScopeRepoIds(['gone-repo'], repoMap)).toEqual([])
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

  function makeEventFor(entry: AgentStatusEntry): ActivityEvent {
    const worktree = makeWorktree()
    return {
      id: `event-${entry.paneKey}`,
      state: 'done',
      timestamp: 1000,
      observedAt: 1000,
      unread: false,
      worktree,
      repo: null,
      tab: makeTabWithIds('tab-1', worktree.id),
      agentType: 'claude',
      agentAlive: true,
      entry
    }
  }

  describe('collectChildAgentPaneKeys', () => {
    it('returns an empty set when no thread carries orchestration', () => {
      const threads = [makeTestThread(PANE_KEY), makeTestThread(PANE_KEY_2)]
      expect(collectChildAgentPaneKeys(threads).size).toBe(0)
    })

    it('classifies a thread whose parent pane is listed as a child', () => {
      const parent = makeTestThread(PANE_KEY)
      const child = makeTestThread(PANE_KEY_2, {
        currentAgentEntry: makeTestEntry(PANE_KEY_2, {
          orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
        })
      })
      expect(collectChildAgentPaneKeys([parent, child])).toEqual(new Set([PANE_KEY_2]))
    })

    it('promotes an orphan whose parent pane is no longer listed', () => {
      const orphan = makeTestThread(PANE_KEY_2, {
        currentAgentEntry: makeTestEntry(PANE_KEY_2, {
          orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
        })
      })
      expect(collectChildAgentPaneKeys([orphan]).size).toBe(0)
    })

    it('ignores a self-referencing parentPaneKey', () => {
      const thread = makeTestThread(PANE_KEY, {
        currentAgentEntry: makeTestEntry(PANE_KEY, {
          orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
        })
      })
      expect(collectChildAgentPaneKeys([thread]).size).toBe(0)
    })

    it('resolves coordinatorHandle through a listed thread terminal handle', () => {
      const coordinator = makeTestThread(PANE_KEY, {
        currentAgentEntry: makeTestEntry(PANE_KEY, { terminalHandle: 'terminal-coord' })
      })
      const worker = makeTestThread(PANE_KEY_2, {
        currentAgentEntry: makeTestEntry(PANE_KEY_2, {
          terminalHandle: 'terminal-worker',
          orchestration: {
            coordinatorHandle: 'terminal-coord',
            taskId: 'task-1',
            dispatchId: 'ctx-1'
          }
        })
      })
      expect(collectChildAgentPaneKeys([coordinator, worker])).toEqual(new Set([PANE_KEY_2]))
    })

    it('promotes a worker whose coordinator handle matches no listed thread', () => {
      const worker = makeTestThread(PANE_KEY_2, {
        currentAgentEntry: makeTestEntry(PANE_KEY_2, {
          terminalHandle: 'terminal-worker',
          orchestration: {
            coordinatorHandle: 'terminal-gone',
            taskId: 'task-1',
            dispatchId: 'ctx-1'
          }
        })
      })
      expect(collectChildAgentPaneKeys([worker]).size).toBe(0)
    })

    it('keeps child classification from an older event while the parent is listed', () => {
      const parent = makeTestThread(PANE_KEY)
      const childEntry = makeTestEntry(PANE_KEY_2, {
        orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
      })
      const child = makeTestThread(PANE_KEY_2, {
        currentAgentEntry: makeTestEntry(PANE_KEY_2),
        events: [makeEventFor(childEntry)]
      })
      expect(collectChildAgentPaneKeys([parent, child])).toEqual(new Set([PANE_KEY_2]))
    })

    it('classifies a grandchild chained through a listed child', () => {
      const root = makeTestThread(PANE_KEY)
      const child = makeTestThread(PANE_KEY_2, {
        currentAgentEntry: makeTestEntry(PANE_KEY_2, {
          orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-1', dispatchId: 'ctx-1' }
        })
      })
      const grandchild = makeTestThread(PANE_KEY_3, {
        currentAgentEntry: makeTestEntry(PANE_KEY_3, {
          orchestration: { parentPaneKey: PANE_KEY_2, taskId: 'task-2', dispatchId: 'ctx-2' }
        })
      })
      expect(collectChildAgentPaneKeys([root, child, grandchild])).toEqual(
        new Set([PANE_KEY_2, PANE_KEY_3])
      )
    })

    it('promotes every member of a parent cycle instead of hiding them all', () => {
      const a = makeTestThread(PANE_KEY, {
        currentAgentEntry: makeTestEntry(PANE_KEY, {
          orchestration: { parentPaneKey: PANE_KEY_2, taskId: 'task-1', dispatchId: 'ctx-1' }
        })
      })
      const b = makeTestThread(PANE_KEY_2, {
        currentAgentEntry: makeTestEntry(PANE_KEY_2, {
          orchestration: { parentPaneKey: PANE_KEY, taskId: 'task-2', dispatchId: 'ctx-2' }
        })
      })
      expect(collectChildAgentPaneKeys([a, b]).size).toBe(0)
    })
  })
}

{
  function makeThread(paneKey: string): AgentPaneThread {
    return {
      paneKey,
      tab: makeTab(),
      worktree: makeWorktree(),
      repo: null,
      currentAgentState: null,
      currentAgentEntry: null,
      latestEvent: null,
      latestTimestamp: 1000,
      agentType: 'claude',
      unread: false,
      paneTitle: `Agent ${paneKey}`,
      responsePreview: '',
      events: []
    }
  }

  function makeGroup(key: string, threadKeys: string[]): ActivityThreadGroup {
    return { key, label: key, threads: threadKeys.map(makeThread) }
  }

  describe('buildActivityVirtualItems', () => {
    it('flattens headers and threads in group order', () => {
      const items = buildActivityVirtualItems({
        groups: [makeGroup('working', ['a', 'b']), makeGroup('done', ['c'])],
        groupBy: 'status',
        collapsedGroupKeys: new Set()
      })
      expect(items.map((item) => getActivityVirtualItemKey(item))).toEqual([
        'h:working',
        't:a',
        't:b',
        'h:done',
        't:c'
      ])
      expect(getActivityHeaderItemIndexes(items)).toEqual([0, 3])
    })

    it('omits header rows entirely when ungrouped', () => {
      const items = buildActivityVirtualItems({
        groups: [{ key: 'all', label: '', threads: [makeThread('a'), makeThread('b')] }],
        groupBy: 'none',
        collapsedGroupKeys: new Set()
      })
      expect(items.map((item) => getActivityVirtualItemKey(item))).toEqual(['t:a', 't:b'])
    })

    it('keeps a collapsed group header but drops its thread rows', () => {
      const items = buildActivityVirtualItems({
        groups: [makeGroup('working', ['a', 'b']), makeGroup('done', ['c'])],
        groupBy: 'status',
        collapsedGroupKeys: new Set(['working'])
      })
      expect(items.map((item) => getActivityVirtualItemKey(item))).toEqual([
        'h:working',
        'h:done',
        't:c'
      ])
    })

    it('locates the selected thread row by paneKey', () => {
      const items = buildActivityVirtualItems({
        groups: [makeGroup('working', ['a', 'b', 'c'])],
        groupBy: 'status',
        collapsedGroupKeys: new Set()
      })
      expect(findActivityThreadItemIndex(items, 'c')).toBe(3)
      expect(findActivityThreadItemIndex(items, 'missing')).toBeNull()
      expect(findActivityThreadItemIndex(items, null)).toBeNull()
    })
  })
}

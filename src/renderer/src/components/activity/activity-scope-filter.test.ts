import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import {
  filterThreadsByActivityScope,
  resolveActivityScopeRepoIds,
  threadMatchesActivityScope,
  type ActivityScopeFilter
} from './activity-scope-filter'
import type { AgentPaneThread } from './activity-thread-types'
import {
  makeRepo,
  makeTabWithIds,
  makeWorktree,
  PANE_KEY
} from './ActivityPrototypePage-test-fixtures'

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

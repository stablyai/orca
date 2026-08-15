import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { flushMicrotasks } from './agent-status-test-harness'
import { createTestStore, makeTab, makeWorktree } from './store-test-helpers'

function stubGitHubPRRefreshApi() {
  const enqueuePRRefresh = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('window', {
    api: {
      gh: { enqueuePRRefresh }
    }
  })
  return enqueuePRRefresh
}

function seedAgentPRRefreshFixture(
  store: ReturnType<typeof createTestStore>,
  worktreeCardProperties: AppState['worktreeCardProperties']
): void {
  store.setState({
    repos: [
      {
        id: 'repo-1',
        path: '/repo',
        displayName: 'Repo',
        badgeColor: '#999999',
        addedAt: 1,
        kind: 'git'
      }
    ],
    groupBy: 'repo',
    rightSidebarOpen: false,
    worktreeCardProperties,
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({
          id: 'wt-1',
          repoId: 'repo-1',
          path: '/repo/worktrees/pr-from-agent',
          branch: 'feature/pr-from-agent'
        })
      ]
    },
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
    }
  } as Partial<AppState>)
}

describe('agent status PR refresh handoff', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('enqueues an active PR refresh for the owning worktree when an agent completes', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['pr'])

    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'create a PR', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'done', prompt: 'create a PR', agentType: 'codex' })

    await flushMicrotasks()

    expect(enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath: '/repo',
        branch: 'feature/pr-from-agent',
        worktreeId: 'wt-1',
        linkedPRNumber: null
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('uses hook worktree attribution for PR refresh when the agent tab is not mounted', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['pr'])
    store.setState({ tabsByWorktree: { 'wt-1': [] } } as Partial<AppState>)
    const paneKey = 'tab-worker:11111111-1111-4111-8111-111111111111'

    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'create a PR', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'tab-worker', worktreeId: 'wt-1', terminalHandle: 'term-worker' }
      )
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'done', prompt: 'create a PR', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'tab-worker', worktreeId: 'wt-1', terminalHandle: 'term-worker' }
      )

    await flushMicrotasks()

    expect(enqueuePRRefresh).toHaveBeenCalledWith({
      candidate: expect.objectContaining({
        repoPath: '/repo',
        branch: 'feature/pr-from-agent',
        worktreeId: 'wt-1',
        linkedPRNumber: null
      }),
      reason: 'active',
      priority: 80
    })
  })

  it('does not spend a PR refresh when no status lane or PR surface is visible', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['comment'])

    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'create a PR', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'done', prompt: 'create a PR', agentType: 'codex' })

    await flushMicrotasks()

    expect(enqueuePRRefresh).not.toHaveBeenCalled()
  })

  it('does not repeat the refresh for same-state done detail updates', async () => {
    vi.useFakeTimers()
    const enqueuePRRefresh = stubGitHubPRRefreshApi()
    const store = createTestStore()
    seedAgentPRRefreshFixture(store, ['pr'])

    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'working', prompt: 'create a PR', agentType: 'codex' })
    store
      .getState()
      .setAgentStatus('tab-1:0', { state: 'done', prompt: 'create a PR', agentType: 'codex' })
    store.getState().setAgentStatus('tab-1:0', {
      state: 'done',
      prompt: 'create a PR',
      agentType: 'codex',
      lastAssistantMessage: 'Opened https://github.com/acme/orca/pull/42'
    })

    await flushMicrotasks()

    expect(enqueuePRRefresh).toHaveBeenCalledTimes(1)
  })
})

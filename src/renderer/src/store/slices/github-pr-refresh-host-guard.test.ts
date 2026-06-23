import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice } from './github'
import { createHostedReviewSlice } from './hosted-review'
import type { AppState } from '../types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

// Why: regression guard for the renderer OOM crash. Enqueuing the local
// `gh:enqueuePRRefresh` for a repo owned by a remote/SSH/runtime host rejects
// with "Access denied: unknown repository path"; a flood of those failures grew
// the renderer heap to the V8 ceiling and crashed it. enqueueGitHubPRRefresh
// must only hit the local handler for local-host repos.
const enqueuePRRefresh = vi.fn().mockResolvedValue(undefined)

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    enqueuePRRefresh,
    issue: vi.fn().mockResolvedValue(null)
  },
  hostedReview: { forBranch: vi.fn().mockResolvedValue(null) },
  runtimeEnvironments: { call: vi.fn() }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createGitHubSlice(...a),
        ...createHostedReviewSlice(...a)
      }) as AppState
  )
}

function seed(store: ReturnType<typeof createTestStore>, repo: Record<string, unknown>) {
  store.setState({
    settings: { activeRuntimeEnvironmentId: null } as never,
    repos: [repo],
    worktreesByRepo: {
      [repo.id as string]: [
        {
          id: 'wt-1',
          repoId: repo.id,
          path: `${repo.path}/wt`,
          branch: 'refs/heads/feature',
          displayName: 'feature',
          isMainWorktree: false,
          isBare: false,
          isArchived: false,
          linkedPR: null,
          linkedIssue: null
        }
      ]
    },
    prCache: {},
    issueCache: {},
    hostedReviewCache: {},
    sshConnectionStates: new Map()
  } as unknown as Partial<AppState>)
}

describe('enqueueGitHubPRRefresh host guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enqueues the local handler for a local-host repo', () => {
    const store = createTestStore()
    seed(store, { id: 'local-1', path: '/Users/me/code/local-1', name: 'local-1', kind: 'git' })

    store.getState().enqueueGitHubPRRefresh('wt-1', 'active', 80)

    expect(enqueuePRRefresh).toHaveBeenCalledTimes(1)
  })

  it('enqueues the local handler for a repo with an explicit local executionHostId', () => {
    const store = createTestStore()
    seed(store, {
      id: 'local-2',
      path: '/Users/me/code/local-2',
      name: 'local-2',
      kind: 'git',
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })

    store.getState().enqueueGitHubPRRefresh('wt-1', 'active', 80)

    expect(enqueuePRRefresh).toHaveBeenCalledTimes(1)
  })

  it('does NOT enqueue the local handler for a runtime-host repo (the OOM loop)', () => {
    const store = createTestStore()
    seed(store, {
      id: 'rt-1',
      path: '/Users/lobster/orca/workspaces/openclaw/imessage-performance',
      name: 'imessage-performance',
      kind: 'git',
      executionHostId: 'runtime:env-1'
    })

    store.getState().enqueueGitHubPRRefresh('wt-1', 'active', 80)

    expect(enqueuePRRefresh).not.toHaveBeenCalled()
  })

  it('does NOT enqueue the local handler for an SSH repo', () => {
    const store = createTestStore()
    seed(store, {
      id: 'ssh-1',
      path: '/home/me/code/ssh-1',
      name: 'ssh-1',
      kind: 'git',
      connectionId: 'conn-1'
    })

    store.getState().enqueueGitHubPRRefresh('wt-1', 'active', 80)

    expect(enqueuePRRefresh).not.toHaveBeenCalled()
  })
})

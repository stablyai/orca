/** Worktree removal must call both generation pruners; PR title/body and commit-message records otherwise leak text under ephemeral worktree/branch keys for renderer lifetime. */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status/aggregation/worktree-agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status/aggregation/worktree-agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn() }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import type { PullRequestGenerationRecord } from '../../hosted-review/generation/pull-request-generation-state'
import type { CommitMessageGenerationRecord } from '../../hosted-review/generation/commit-message-generation'

const REPO = 'repo1'
const WT = 'repo1::/path/wt1'
const WT_PATH = '/path/wt1'
const OTHER = 'repo1::/path/wt2'
const OTHER_PATH = '/path/wt2'
const BRANCH = 'refs/heads/feature'

function prRecord(worktreeId: string, worktreePath: string): PullRequestGenerationRecord {
  return {
    context: {
      worktreeId,
      worktreePath,
      requestId: 1,
      repoId: REPO,
      branch: BRANCH,
      runtimeTarget: { kind: 'local' }
    },
    seed: { base: 'main', title: 'Title', body: 'Body', draft: false },
    seedFieldRevisions: { base: 0, title: 0, body: 0, draft: 0 },
    requiresPushBeforeCreate: false,
    status: 'succeeded',
    result: null,
    error: null,
    hydrated: true
  }
}

function commitRecord(worktreeId: string, worktreePath: string): CommitMessageGenerationRecord {
  return {
    context: { worktreeId, worktreePath, requestId: 1, runtimeTarget: { kind: 'local' } },
    status: 'succeeded',
    message: 'a generated commit message',
    error: null,
    hydrated: true
  }
}

describe('worktree removal evicts generation records (leak regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.remove.mockResolvedValue(undefined)
  })

  it('removes PR + commit generation records for the removed worktree and keeps others', async () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WT, repoId: REPO, path: WT_PATH }),
          makeWorktree({ id: OTHER, repoId: REPO, path: OTHER_PATH })
        ]
      }
    })
    store
      .getState()
      .setPullRequestGenerationRecord(
        '["repo1","repo1::/path/wt1","refs/heads/feature"]',
        prRecord(WT, WT_PATH)
      )
    store
      .getState()
      .setPullRequestGenerationRecord(
        '["repo1","repo1::/path/wt2","refs/heads/feature"]',
        prRecord(OTHER, OTHER_PATH)
      )
    store.getState().setCommitMessageGenerationRecord('repo1::/path/wt1', commitRecord(WT, WT_PATH))
    store
      .getState()
      .setCommitMessageGenerationRecord('repo1::/path/wt2', commitRecord(OTHER, OTHER_PATH))

    const result = await store.getState().removeWorktree({ id: WT, executionHostId: null })
    expect(result).toEqual({ ok: true })

    const s = store.getState()
    expect(
      s.pullRequestGenerationRecords['["repo1","repo1::/path/wt1","refs/heads/feature"]']
    ).toBeUndefined()
    expect(s.commitMessageGenerationRecords['repo1::/path/wt1']).toBeUndefined()
    expect(
      s.pullRequestGenerationRecords['["repo1","repo1::/path/wt2","refs/heads/feature"]']?.seed
    ).toEqual({ base: 'main', title: 'Title', body: 'Body', draft: false })
    expect(s.commitMessageGenerationRecords['repo1::/path/wt2']?.message).toBe(
      'a generated commit message'
    )
  })
})

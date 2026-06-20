/**
 * Memory-leak regression: PR-generation and commit-message-generation records
 * must be evicted when their worktree is removed.
 *
 * Both records are keyed by worktree (the PR map by a composite
 * [repoId, worktreeKey, branch] key, the commit map by worktreeKey) and each
 * retains generated title/body/message text. The slices ship tested
 * `prunePullRequestGenerationRecords` / `pruneCommitMessageGenerationRecords`
 * actions, but nothing in production called them on worktree removal, so the
 * records accumulated one entry per worktree for the renderer session.
 * `removeWorktree` now prunes both maps to the surviving worktree set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn()
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

const mockApi = {
  worktrees: {
    list: vi.fn().mockResolvedValue([]),
    remove: vi.fn().mockResolvedValue(undefined),
    forceDeletePreservedBranch: vi.fn().mockResolvedValue({ deleted: true }),
    updateMeta: vi.fn().mockResolvedValue({})
  },
  pty: { kill: vi.fn().mockResolvedValue(undefined) },
  runtimeEnvironments: { call: vi.fn() }
}

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: mockApi }

import { createTestStore, seedStore, makeWorktree } from './store-test-helpers'
import {
  getPullRequestGenerationRecordKey,
  type PullRequestGenerationRecord
} from './pull-request-generation'
import {
  getCommitMessageGenerationRecordKey,
  type CommitMessageGenerationRecord
} from './commit-message-generation'

const REPO = 'repo1'
const WT = 'repo1::/path/wt1'
const WT_PATH = '/path/wt1'
const OTHER = 'repo1::/path/wt2'
const OTHER_PATH = '/path/wt2'
const BRANCH = 'refs/heads/feature'

function prRecord(worktreeId: string, worktreePath: string): PullRequestGenerationRecord {
  return {
    context: { worktreeId, worktreePath, requestId: 1, repoId: REPO, branch: BRANCH },
    seed: { base: 'main', title: 'Title', body: 'Body', draft: false },
    seedFieldRevisions: { base: 0, title: 0, body: 0, draft: 0 },
    status: 'succeeded',
    result: null,
    error: null,
    hydrated: true
  }
}

function commitRecord(worktreeId: string, worktreePath: string): CommitMessageGenerationRecord {
  return {
    context: { worktreeId, worktreePath, requestId: 1 },
    status: 'succeeded',
    message: 'a generated commit message',
    error: null,
    hydrated: true
  }
}

function prKey(worktreeId: string, worktreePath: string): string {
  const key = getPullRequestGenerationRecordKey({
    worktreeId,
    worktreePath,
    repoId: REPO,
    branch: BRANCH
  })
  if (!key) {
    throw new Error('expected a PR generation key')
  }
  return key
}

function commitKey(worktreeId: string, worktreePath: string): string {
  const key = getCommitMessageGenerationRecordKey(worktreeId, worktreePath)
  if (!key) {
    throw new Error('expected a commit generation key')
  }
  return key
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
    store.getState().setPullRequestGenerationRecord(prKey(WT, WT_PATH), prRecord(WT, WT_PATH))
    store
      .getState()
      .setPullRequestGenerationRecord(prKey(OTHER, OTHER_PATH), prRecord(OTHER, OTHER_PATH))
    store
      .getState()
      .setCommitMessageGenerationRecord(commitKey(WT, WT_PATH), commitRecord(WT, WT_PATH))
    store
      .getState()
      .setCommitMessageGenerationRecord(
        commitKey(OTHER, OTHER_PATH),
        commitRecord(OTHER, OTHER_PATH)
      )

    const result = await store.getState().removeWorktree(WT)
    expect(result).toEqual({ ok: true })

    const s = store.getState()
    // Removed worktree's records are gone (the leak).
    expect(s.pullRequestGenerationRecords[prKey(WT, WT_PATH)]).toBeUndefined()
    expect(s.commitMessageGenerationRecords[commitKey(WT, WT_PATH)]).toBeUndefined()
    // Surviving worktree's records are preserved (no over-pruning).
    expect(s.pullRequestGenerationRecords[prKey(OTHER, OTHER_PATH)]).toBeDefined()
    expect(s.commitMessageGenerationRecords[commitKey(OTHER, OTHER_PATH)]).toBeDefined()
  })
})

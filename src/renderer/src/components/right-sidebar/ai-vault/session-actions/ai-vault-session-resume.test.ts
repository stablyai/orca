import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AiVaultSessionWorktreeInfo } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'

import { resolveAiVaultSessionResumeState } from './ai-vault-session-resume'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/orca',
    repoId: 'repo-1',
    displayName: 'orca',
    path: '/repo/orca',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    isMainWorktree: false,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo/orca',
    displayName: 'orca',
    badgeColor: '#000000',
    addedAt: 1,
    ...overrides
  }
}

function makeWorktreeInfo(
  status: AiVaultSessionWorktreeInfo['status']
): AiVaultSessionWorktreeInfo {
  return {
    status,
    label: 'orca',
    path: '/repo/orca',
    ...(status === 'unavailable' ? {} : { worktreeId: 'repo-1::/repo/orca' })
  }
}

const HOST_SESSION_FILE = '/Users/ada/.claude/projects/-repo-orca/session-1.jsonl'

describe('resolveAiVaultSessionResumeState', () => {
  it('prefers the session worktree over the active workspace', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-1::/repo/other',
        worktrees: [
          makeWorktree(),
          makeWorktree({ id: 'repo-1::/repo/other', path: '/repo/other' })
        ],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: true
    })
  })

  it('falls back to the active workspace when the session worktree is runtime-owned', () => {
    expect(
      resolveAiVaultSessionResumeState({
        sessionFilePath: HOST_SESSION_FILE,
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/repo/other',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/repo/other',
            repoId: 'repo-2',
            path: '/repo/other'
          })
        ],
        repos: [
          makeRepo({ connectionId: null, executionHostId: 'runtime:env-1' }),
          makeRepo({
            id: 'repo-2',
            path: '/repo/other',
            connectionId: null,
            executionHostId: 'local'
          })
        ]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-2::/repo/other',
      usesSessionWorktree: false
    })
  })
})

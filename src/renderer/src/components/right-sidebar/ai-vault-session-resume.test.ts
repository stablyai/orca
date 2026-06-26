import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../../shared/types'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'
import {
  aiVaultSessionResumeLabel,
  resolveAiVaultSessionResumeActions,
  resolveAiVaultSessionResumeState
} from './ai-vault-session-resume'

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

describe('resolveAiVaultSessionResumeState', () => {
  it('prefers the session worktree over the active workspace', () => {
    expect(
      resolveAiVaultSessionResumeState({
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

  it('falls back to the active workspace when the session worktree is unavailable', () => {
    expect(
      resolveAiVaultSessionResumeState({
        worktreeInfo: makeWorktreeInfo('archived'),
        activeWorktreeId: 'repo-1::/repo/orca',
        worktrees: [makeWorktree()],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      blocked: false,
      worktreeId: 'repo-1::/repo/orca',
      usesSessionWorktree: false
    })
  })

  it('blocks remote targets and missing worktrees', () => {
    expect(
      resolveAiVaultSessionResumeState({
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [],
        repos: [{ id: 'repo-1', connectionId: 'ssh-1' } as Repo]
      })
    ).toEqual({
      blocked: true,
      worktreeId: null,
      usesSessionWorktree: false
    })
  })

  it('blocks runtime-owned targets even when they have no SSH connection', () => {
    expect(
      resolveAiVaultSessionResumeState({
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: null,
        worktrees: [makeWorktree()],
        repos: [
          makeRepo({
            connectionId: null,
            executionHostId: 'runtime:env-1'
          })
        ]
      })
    ).toEqual({
      blocked: true,
      worktreeId: null,
      usesSessionWorktree: false
    })
  })

  it('uses a local session worktree when the active workspace is remote', () => {
    expect(
      resolveAiVaultSessionResumeState({
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/remote/orca',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/remote/orca',
            repoId: 'repo-2',
            path: '/remote/orca'
          })
        ],
        repos: [{ id: 'repo-1' } as Repo, { id: 'repo-2', connectionId: 'ssh-1' } as Repo]
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

describe('resolveAiVaultSessionResumeActions', () => {
  it('exposes separate session-worktree and active-workspace targets', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-1::/repo/other',
        worktrees: [
          makeWorktree(),
          makeWorktree({ id: 'repo-1::/repo/other', path: '/repo/other' })
        ],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: false },
      newTab: { worktreeId: 'repo-1::/repo/other', disabled: false }
    })
  })

  it('disables only the remote active-workspace action when the session worktree is local', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        worktreeInfo: makeWorktreeInfo('active'),
        activeWorktreeId: 'repo-2::/remote/orca',
        worktrees: [
          makeWorktree(),
          makeWorktree({
            id: 'repo-2::/remote/orca',
            repoId: 'repo-2',
            path: '/remote/orca'
          })
        ],
        repos: [{ id: 'repo-1' } as Repo, { id: 'repo-2', connectionId: 'ssh-1' } as Repo]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: false },
      newTab: { worktreeId: 'repo-2::/remote/orca', disabled: true }
    })
  })

  it('disables runtime-owned targets without disabling local targets', () => {
    expect(
      resolveAiVaultSessionResumeActions({
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
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: true },
      newTab: { worktreeId: 'repo-2::/repo/other', disabled: false }
    })
  })

  it('does not expose the active workspace as a duplicate new-tab target', () => {
    expect(
      resolveAiVaultSessionResumeActions({
        worktreeInfo: makeWorktreeInfo('current'),
        activeWorktreeId: 'repo-1::/repo/orca',
        worktrees: [makeWorktree()],
        repos: [{ id: 'repo-1' } as Repo]
      })
    ).toEqual({
      worktree: { worktreeId: 'repo-1::/repo/orca', disabled: false },
      newTab: { worktreeId: null, disabled: true }
    })
  })
})

describe('aiVaultSessionResumeLabel', () => {
  it('names the session worktree action distinctly from the active-workspace fallback', () => {
    expect(aiVaultSessionResumeLabel({ usesSessionWorktree: true })).toBe('Resume in Worktree')
    expect(aiVaultSessionResumeLabel({ usesSessionWorktree: false })).toBe('Resume in New Tab')
  })
})

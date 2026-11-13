import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

import { resolveAiVaultSessionWorktreeInfo } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'

const baseSession: AiVaultSession = {
  id: 'codex:session-1',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: 'session-1',
  title: 'Find the pane',
  cwd: '/repo/orca/src',
  branch: null,
  model: null,
  filePath: '/home/ada/.codex/session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: '2026-06-24T10:00:00.000Z',
  modifiedAt: '2026-06-24T10:00:00.000Z',
  messageCount: 2,
  totalTokens: 42,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "codex resume 'session-1'",
  subagent: null
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktree: Worktree = {
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
    isMainWorktree: false
  }
  return { ...worktree, ...overrides }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo/orca',
    displayName: 'orca',
    badgeColor: '#737373',
    addedAt: 1,
    connectionId: null,
    executionHostId: 'local',
    ...overrides
  }
}

describe('resolveAiVaultSessionWorktreeInfo', () => {
  it('ranks each same-host candidate by its closest cwd spelling, independent of link length or alias order', () => {
    const parent = makeWorktree({ id: 'parent', path: '/a-very-long-parent-link' })
    const child = makeWorktree({ id: 'child', path: '/short', priorWorktreeIds: ['repo-1::/old'] })
    const foreign = makeWorktree({ id: 'foreign', path: '/other-host', hostId: 'runtime:other' })
    for (const cwdAliases of [
      ['/a-very-long-parent-link/child', '/short/nested', '/short', '/other-host'],
      ['/other-host', '/short', '/short/nested', '/a-very-long-parent-link/child']
    ]) {
      expect(
        resolveAiVaultSessionWorktreeInfo({
          session: { ...baseSession, cwd: '/physical/child', cwdAliases },
          worktrees: [parent, foreign, child],
          activeWorktreeId: 'parent'
        })
      ).toMatchObject({ worktreeId: 'child', path: '/short', status: 'active' })
    }
  })

  it('keeps current-path ownership ahead of a prior-path alias tie', () => {
    const prior = makeWorktree({
      id: 'renamed',
      path: '/renamed',
      priorWorktreeIds: ['repo-1::/link']
    })
    const current = makeWorktree({ id: 'current', path: '/link' })
    expect(
      resolveAiVaultSessionWorktreeInfo({
        session: { ...baseSession, cwd: '/physical', cwdAliases: ['/link'] },
        worktrees: [prior, current],
        activeWorktreeId: null
      })?.worktreeId
    ).toBe('current')
  })

  it('uses the session host when multiple worktrees share the same path', () => {
    const localWorktree = makeWorktree({
      id: 'repo-local::/srv/orca',
      repoId: 'repo-local',
      displayName: 'local',
      path: '/srv/orca',
      hostId: 'local'
    })
    const sshWorktree = makeWorktree({
      id: 'repo-ssh::/srv/orca',
      repoId: 'repo-ssh',
      displayName: 'ssh',
      path: '/srv/orca',
      hostId: 'ssh:target-1'
    })

    expect(
      resolveAiVaultSessionWorktreeInfo({
        session: { ...baseSession, cwd: '/srv/orca/src', executionHostId: 'ssh:target-1' },
        worktrees: [localWorktree, sshWorktree],
        activeWorktreeId: null
      })
    ).toMatchObject({
      label: 'ssh',
      worktreeId: sshWorktree.id
    })
  })

  it('uses the live recorded folder workspace when several folder workspaces share one path', () => {
    const worktrees = [
      makeWorktree({ id: 'folder:topic-a', displayName: 'Topic A', path: '/repo/shared' }),
      makeWorktree({ id: 'folder:topic-b', displayName: 'Topic B', path: '/repo/shared' }),
      makeWorktree({
        id: 'folder:topic-c',
        displayName: 'Topic C',
        path: '/repo/shared',
        isArchived: true
      })
    ]
    const resolveRecorded = (workspaceId: string) =>
      resolveAiVaultSessionWorktreeInfo({
        session: {
          ...baseSession,
          cwd: '/repo/shared',
          structuredSession: { sessionId: 'session-1', workspaceId }
        },
        worktrees,
        activeWorktreeId: null
      })

    expect(resolveRecorded('folder:topic-b')).toMatchObject({
      label: 'Topic B',
      path: '/repo/shared',
      status: 'active',
      worktreeId: 'folder:topic-b'
    })
    // An archived recorded workspace falls back to the live cwd owner.
    expect(resolveRecorded('folder:topic-c')).toMatchObject({
      status: 'active',
      worktreeId: 'folder:topic-a'
    })
  })

  it('uses repo host ownership when a legacy worktree lacks host metadata', () => {
    const worktree = makeWorktree({
      id: 'repo-ssh::/srv/orca',
      repoId: 'repo-ssh',
      displayName: 'ssh',
      path: '/srv/orca'
    })

    expect(
      resolveAiVaultSessionWorktreeInfo({
        session: { ...baseSession, cwd: '/srv/orca/src', executionHostId: 'ssh:target-1' },
        repos: [makeRepo({ id: 'repo-ssh', connectionId: 'target-1', executionHostId: null })],
        worktrees: [worktree],
        activeWorktreeId: null
      })
    ).toMatchObject({
      label: 'ssh',
      worktreeId: worktree.id
    })
  })
})

import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { AiVaultSessionResumeTargetState } from '../right-sidebar/ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from '../right-sidebar/ai-vault-session-worktree'
import { resolveSessionsBoardCardAvailability } from './sessions-board-card-availability'

const SESSION_FILE = '/Users/ada/.claude/projects/-repo-orca/session-1.jsonl'
const WORKTREE_ID = 'repo-1::/repo/orca'

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:claude:sess-1',
    executionHostId: 'local',
    agent: 'claude',
    sessionId: 'sess-1',
    title: 'Ship the board',
    cwd: '/repo/orca',
    branch: 'main',
    model: null,
    filePath: SESSION_FILE,
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 4,
    totalTokens: 0,
    previewMessages: [{ role: 'user', text: 'go', timestamp: null }],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'claude --resume sess-1',
    subagent: null,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
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
    ...(status === 'unavailable' ? {} : { worktreeId: WORKTREE_ID })
  }
}

/** The shape `useSessionsBoardCardAvailability` hands over: one worktree, indexed by repo. */
function makeTargetState(
  worktrees: readonly Worktree[] = [makeWorktree()]
): AiVaultSessionResumeTargetState {
  return {
    folderWorkspaces: [],
    projectGroups: [],
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [...worktrees] }
  }
}

describe('resolveSessionsBoardCardAvailability', () => {
  it('offers both actions for a session in an open workspace', () => {
    const availability = resolveSessionsBoardCardAvailability({
      session: makeSession(),
      worktreeInfo: makeWorktreeInfo('active'),
      repos: [makeRepo()],
      ownerWorkspaces: [makeWorktree()],
      targetState: makeTargetState()
    })

    expect(availability).toEqual({
      worktreeInfo: makeWorktreeInfo('active'),
      jumpWorktreeId: WORKTREE_ID,
      resumeWorktreeId: WORKTREE_ID,
      resumeDisabled: false,
      resumeBlocked: false,
      canCopyResumeCommand: true
    })
  })

  it('disables both actions when the cwd matches nothing open', () => {
    const availability = resolveSessionsBoardCardAvailability({
      session: makeSession(),
      worktreeInfo: null,
      repos: [makeRepo()],
      ownerWorkspaces: [makeWorktree()],
      targetState: makeTargetState()
    })

    expect(availability.jumpWorktreeId).toBeNull()
    expect(availability.resumeWorktreeId).toBeNull()
    expect(availability.resumeDisabled).toBe(true)
    expect(availability.resumeBlocked).toBe(true)
  })

  it('refuses to fall back to another open workspace', () => {
    // The board is machine-wide, so this session's workspace is not the one on screen. An
    // active-worktree fallback would silently resume in an unrelated directory; the null
    // `activeWorktreeId` is what makes that impossible rather than merely unlikely.
    const availability = resolveSessionsBoardCardAvailability({
      session: makeSession({ cwd: '/elsewhere/other', filePath: '/other/session.jsonl' }),
      worktreeInfo: null,
      repos: [makeRepo()],
      ownerWorkspaces: [makeWorktree()],
      targetState: makeTargetState()
    })

    expect(availability.resumeDisabled).toBe(true)
    expect(availability.resumeBlocked).toBe(true)
  })

  it('keeps jump refused for an archived worktree', () => {
    const availability = resolveSessionsBoardCardAvailability({
      session: makeSession(),
      worktreeInfo: makeWorktreeInfo('archived'),
      repos: [makeRepo()],
      ownerWorkspaces: [makeWorktree({ isArchived: true })],
      targetState: makeTargetState([makeWorktree({ isArchived: true })])
    })

    expect(availability.jumpWorktreeId).toBeNull()
    expect(availability.resumeDisabled).toBe(true)
  })

  it('separates an unresumable session from an unreachable workspace', () => {
    // The workspace is fine and reachable; the session simply recorded no conversation, so
    // the card must not blame the workspace for it.
    const availability = resolveSessionsBoardCardAvailability({
      session: makeSession({ messageCount: 0, previewMessages: [] }),
      worktreeInfo: makeWorktreeInfo('active'),
      repos: [makeRepo()],
      ownerWorkspaces: [makeWorktree()],
      targetState: makeTargetState()
    })

    expect(availability.jumpWorktreeId).toBe(WORKTREE_ID)
    expect(availability.resumeDisabled).toBe(true)
    expect(availability.resumeBlocked).toBe(false)
    expect(availability.canCopyResumeCommand).toBe(false)
  })

  it('keeps jump while a host mismatch blocks resume', () => {
    const sshRepo = makeRepo({ connectionId: 'ssh-1' })
    const availability = resolveSessionsBoardCardAvailability({
      session: makeSession(),
      worktreeInfo: makeWorktreeInfo('active'),
      repos: [sshRepo],
      ownerWorkspaces: [makeWorktree()],
      targetState: { ...makeTargetState(), repos: [sshRepo] }
    })

    expect(availability.jumpWorktreeId).toBe(WORKTREE_ID)
    expect(availability.resumeDisabled).toBe(true)
    expect(availability.resumeBlocked).toBe(true)
  })
})

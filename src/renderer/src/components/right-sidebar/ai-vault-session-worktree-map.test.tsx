// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo, Worktree } from '../../../../shared/types'
import {
  resolveAiVaultSessionWorktreeDisplay,
  useAiVaultSessionWorktreeMap,
  withAiVaultCurrentWorktreeStatus
} from './ai-vault-session-worktree'

function makeSession(overrides: Partial<AiVaultSession>): AiVaultSession {
  return {
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
    subagent: null,
    ...overrides
  }
}

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
    badgeColor: '#737373',
    addedAt: 1,
    connectionId: null,
    executionHostId: 'local',
    ...overrides
  }
}

const worktreeA = makeWorktree({ id: 'repo-1::/repo/alpha', path: '/repo/alpha' })
const worktreeB = makeWorktree({ id: 'repo-1::/repo/beta', path: '/repo/beta' })
const sessionInA = makeSession({ id: 'codex:in-a', cwd: '/repo/alpha/src' })
const sessionInB = makeSession({ id: 'codex:in-b', cwd: '/repo/beta' })
const sessionUnmatched = makeSession({ id: 'codex:lost', cwd: '/elsewhere/deep' })
const repos = [makeRepo()]
const worktrees = [worktreeA, worktreeB]
const sessions = [sessionInA, sessionInB, sessionUnmatched]

describe('useAiVaultSessionWorktreeMap', () => {
  it('keeps the map identity across worktree switches while the current flag moves', () => {
    // Mirrors the panel wiring: cached map + per-row current stamping.
    const { result, rerender } = renderHook(
      ({ activeWorktreeId }: { activeWorktreeId: string | null }) => {
        const map = useAiVaultSessionWorktreeMap({ sessions, repos, worktrees })
        return {
          map,
          infoFor: (sessionId: string) =>
            withAiVaultCurrentWorktreeStatus(map.get(sessionId) ?? null, activeWorktreeId)
        }
      },
      { initialProps: { activeWorktreeId: worktreeA.id as string | null } }
    )

    const firstMap = result.current.map
    expect(result.current.infoFor(sessionInA.id)?.status).toBe('current')
    expect(result.current.infoFor(sessionInB.id)?.status).toBe('active')

    rerender({ activeWorktreeId: worktreeB.id })

    // The switch must not rebuild the 500-session map — only the stamp moves.
    expect(result.current.map).toBe(firstMap)
    expect(result.current.infoFor(sessionInA.id)?.status).toBe('active')
    expect(result.current.infoFor(sessionInB.id)?.status).toBe('current')
  })

  it('render-time stamping matches per-session resolution for every status case', () => {
    const sshWorktree = makeWorktree({
      id: 'repo-ssh::/srv/orca',
      repoId: 'repo-ssh',
      displayName: 'ssh',
      path: '/srv/orca',
      hostId: 'ssh:target-1'
    })
    const archivedWorktree = makeWorktree({
      id: 'repo-1::/repo/attic',
      path: '/repo/attic',
      isArchived: true
    })
    const allWorktrees = [...worktrees, sshWorktree, archivedWorktree]
    const allRepos = [...repos, makeRepo({ id: 'repo-ssh', path: '/srv/orca' })]
    const allSessions = [
      sessionInA, // active worktree
      sessionInB, // non-active worktree
      sessionUnmatched, // no worktree match
      makeSession({ id: 'codex:ssh', cwd: '/srv/orca/src', executionHostId: 'ssh:target-1' }),
      makeSession({ id: 'codex:attic', cwd: '/repo/attic' }),
      makeSession({ id: 'codex:no-cwd', cwd: null, branch: 'feature/x' })
    ]

    const { result } = renderHook(() =>
      useAiVaultSessionWorktreeMap({
        sessions: allSessions,
        repos: allRepos,
        worktrees: allWorktrees
      })
    )

    for (const activeWorktreeId of [worktreeA.id, sshWorktree.id, archivedWorktree.id, null]) {
      for (const session of allSessions) {
        expect(
          withAiVaultCurrentWorktreeStatus(result.current.get(session.id) ?? null, activeWorktreeId)
        ).toEqual(
          resolveAiVaultSessionWorktreeDisplay({
            session,
            repos: allRepos,
            worktrees: allWorktrees,
            activeWorktreeId
          })
        )
      }
    }
  })

  it('matches non-ASCII cwds regardless of unicode normalization form', () => {
    // macOS file pickers yield NFD while agents record NFC cwds (#10832) —
    // explicit escapes so tooling can't silently re-normalize the fixture.
    const nfcCafe = makeWorktree({ id: 'repo-1::/repo/caf\u00e9', path: '/repo/caf\u00e9' })
    const cjk = makeWorktree({ id: 'repo-1::/repo/作業区', path: '/repo/作業区' })
    const nfdSession = makeSession({ id: 'codex:nfd', cwd: '/repo/cafe\u0301/src' })
    const cjkSession = makeSession({ id: 'codex:cjk', cwd: '/repo/作業区/src' })

    const { result } = renderHook(() =>
      useAiVaultSessionWorktreeMap({
        sessions: [nfdSession, cjkSession],
        repos,
        worktrees: [nfcCafe, cjk]
      })
    )

    expect(result.current.get(nfdSession.id)).toMatchObject({
      status: 'active',
      worktreeId: nfcCafe.id
    })
    expect(
      withAiVaultCurrentWorktreeStatus(result.current.get(nfdSession.id) ?? null, nfcCafe.id)
        ?.status
    ).toBe('current')
    expect(result.current.get(cjkSession.id)).toMatchObject({
      status: 'active',
      worktreeId: cjk.id
    })
  })
})

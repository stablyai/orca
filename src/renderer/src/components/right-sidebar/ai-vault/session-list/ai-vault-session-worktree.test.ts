import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

import {
  aiVaultHistoryWorktrees,
  findAiVaultHistoryWorktree
} from '@/lib/agent-session/resume/history/ai-vault-history-worktrees'
import type { AiVaultHistoryWorktreeState } from '@/lib/agent-session/resume/history/ai-vault-history-worktrees'
import { getAiVaultResumeWorkspaceTargetStatus } from '@/lib/agent-session/resume/history/ai-vault-resume-target'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { toDetectedWorktree } from '../../../../../../shared/worktree/ownership'
import {
  buildAiVaultSessionWorktreeMap,
  resolveAiVaultSessionWorktreeInfo
} from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'

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

it('matches original bare History aliases without admitting unrelated hidden policy rows or guessing a host', () => {
  const repo = makeRepo({
    addedAt: Date.parse('2026-11-11T12:00:00Z'),
    externalWorktreeVisibility: 'hide'
  })
  const settings = getDefaultSettings('/tmp')
  const detected = (worktree: Worktree) =>
    toDetectedWorktree({
      repo,
      worktree,
      settings,
      knownOrcaLayouts: [{ path: '/managed', nestWorkspaces: true }]
    })
  const original = detected(
    makeWorktree({
      isBare: true,
      hostId: 'local',
      priorWorktreeIds: ['repo-1::/old']
    })
  )
  const hidden = detected(
    makeWorktree({
      id: 'hidden',
      path: '/repo/orca/deep',
      hostId: 'local'
    })
  )
  const hiddenBare = detected(
    makeWorktree({
      id: 'hidden-bare',
      path: '/repo/orca/deep/.bare',
      isBare: true,
      hostId: 'local'
    })
  )
  const state = {
    repos: [repo],
    settings,
    worktreesByRepo: {},
    detectedWorktreesByRepo: {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [original, hidden, hiddenBare]
      }
    }
  } satisfies AiVaultHistoryWorktreeState
  const worktrees = aiVaultHistoryWorktrees([], state)
  const record = { ...baseSession, cwd: '/physical', cwdAliases: ['/old/src'] }
  const map = buildAiVaultSessionWorktreeMap({ sessions: [record], repos: [repo], worktrees })
  expect(map.get(record.id)).toMatchObject({
    worktreeId: original.id,
    path: '/old',
    status: 'active'
  })
  expect(worktrees).toEqual([original])
  expect(findAiVaultHistoryWorktree(state, original.id, 'local')?.path).toBe('/repo/orca')
  expect(findAiVaultHistoryWorktree(state, original.id, 'runtime:foreign')).toBeUndefined()
  expect(findAiVaultHistoryWorktree(state, original.id)).toBeUndefined()
})

it('keeps an original SSH record on its execution host through a paired transport and leaves rival raw owners unresolved', () => {
  const repo = makeRepo({ connectionId: 'target-1', executionHostId: 'runtime:hub' })
  const settings = getDefaultSettings('/tmp')
  const original = toDetectedWorktree({
    repo,
    worktree: makeWorktree({
      isBare: true,
      hostId: 'ssh:target-1',
      runtimeOwnerEnvironmentId: 'hub'
    }),
    settings,
    knownOrcaLayouts: []
  })
  const state = {
    repos: [repo],
    settings,
    folderWorkspaces: [],
    projectGroups: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {
      'repo-1': {
        repoId: 'repo-1',
        authoritative: true,
        source: 'git',
        worktrees: [original]
      }
    }
  } satisfies AiVaultHistoryWorktreeState
  const record: AiVaultSession = { ...baseSession, executionHostId: 'ssh:target-1' }
  const worktrees = aiVaultHistoryWorktrees([], state)
  expect(
    buildAiVaultSessionWorktreeMap({ sessions: [record], repos: [repo], worktrees }).get(record.id)
      ?.worktreeId
  ).toBe(original.id)
  expect(findAiVaultHistoryWorktree(state, original.id, 'ssh:target-1')).toBe(original)
  expect(getAiVaultResumeWorkspaceTargetStatus(state, original.id, 'ssh:target-1')).toBe('ssh')
  expect(findAiVaultHistoryWorktree(state, original.id, 'local')).toBeUndefined()

  const local: typeof original = {
    ...original,
    hostId: 'local',
    runtimeOwnerEnvironmentId: undefined
  }
  const unproven = { ...local, hostId: undefined }
  const collision = {
    ...state,
    repos: [makeRepo()],
    detectedWorktreesByRepo: {
      'repo-1': { ...state.detectedWorktreesByRepo['repo-1'], worktrees: [local, unproven] }
    }
  } satisfies AiVaultHistoryWorktreeState
  expect(aiVaultHistoryWorktrees([], collision)).toEqual([local, unproven])
  expect(findAiVaultHistoryWorktree(collision, original.id, 'local')).toBeUndefined()
})

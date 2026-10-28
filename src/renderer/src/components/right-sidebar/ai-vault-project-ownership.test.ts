import { expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildAiVaultProjectContext,
  buildAiVaultSessionProjectById
} from './ai-vault-session-projects'
import { resolveProjectHostSetupProjection } from '../../../../shared/project-catalog-canonical-projection'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'

const baseSession: AiVaultSession = {
  id: 'claude:1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'session-1',
  title: 'Implement project history',
  cwd: '/Users/ada/orca',
  branch: 'feature/history',
  model: 'claude-sonnet-4-5',
  filePath: '/Users/ada/.claude/projects/session-1.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 4,
  totalTokens: 1200,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "cd '/Users/ada/orca' && claude --resume 'session-1'",
  subagent: null
}

// #28589: an imported folder whose copied .git/config points at another checkout's remote.
it("keeps a same-host folder that shares a remote out of the other checkout's project", () => {
  const remote = {
    canonicalKey: 'github.com/bennyoooo/open-social',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/Bennyoooo/open-social.git'
  }
  const openSocial = makeRepo({
    id: 'open-social',
    displayName: 'open-social',
    path: '/Users/benny/orca/open-social',
    addedAt: 100,
    gitRemoteIdentity: remote
  })
  const niw = makeRepo({
    id: 'niw',
    displayName: 'niw',
    path: '/Users/benny/orca/projects/niw',
    addedAt: 200,
    gitRemoteIdentity: remote
  })
  const linkedPath = '/Users/benny/workspaces/niw-topic'
  const oldProjectId = 'github:bennyoooo/open-social'
  const worktree = makeWorktree({
    id: `niw::${linkedPath}`,
    repoId: niw.id,
    projectHostSetupId: niw.id,
    projectId: oldProjectId,
    path: linkedPath
  })
  const niwSession = makeSession({ id: 'claude:niw', cwd: linkedPath })
  const derived = projectHostSetupProjectionFromRepos([niw, openSocial])
  const rawSetups = derived.setups.map((setup) => ({ ...setup, projectId: oldProjectId }))
  const projection = resolveProjectHostSetupProjection(
    [niw, openSocial],
    [{ ...derived.projects[0], id: oldProjectId, sourceRepoIds: [niw.id, openSocial.id] }],
    rawSetups
  )
  expect(rawSetups.every((setup) => setup.projectId === oldProjectId)).toBe(true)
  expect(projection.projects.find((project) => project.id === oldProjectId)?.sourceRepoIds).toEqual(
    [openSocial.id]
  )
  const openSocialSession = makeSession({ id: 'claude:open-social', cwd: openSocial.path })

  const context = buildAiVaultProjectContext({
    repos: [niw, openSocial],
    worktrees: [worktree],
    projectHostSetupProjection: projection,
    activeRepo: niw,
    activeWorktree: worktree,
    sessions: [niwSession, openSocialSession]
  })

  expect(context.activeProjectKey).toBe('repo:niw')
  expect(context.sessionProjectById.get(niwSession.id)).toMatchObject({
    key: 'repo:niw',
    label: 'niw'
  })
  expect(context.sessionProjectById.get(openSocialSession.id)).toMatchObject({
    key: 'project:github:bennyoooo/open-social',
    label: 'open-social'
  })
})

function makeSession(overrides: Partial<AiVaultSession>): AiVaultSession {
  return { ...baseSession, ...overrides }
}

function makeRepo(overrides: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: '/Users/ada/orca',
    displayName: 'Orca',
    badgeColor: '#737373',
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    path: '/Users/ada/orca',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    ...overrides
  }
}

it('retains both hosts of a same-id repo for indexing-off managed history and prior workspace ownership', () => {
  const local = makeRepo({ id: 'same', path: '/local/app', addedAt: 1 })
  const remote = makeRepo({
    ...local,
    path: '/remote/app',
    executionHostId: 'runtime:remote',
    addedAt: 2
  })
  const repos = [local, remote]
  const projection = resolveProjectHostSetupProjection(repos, [], [])
  const sessions = [
    makeSession({ id: 'local-managed', cwd: '/managed/app/topic' }),
    makeSession({
      id: 'remote-managed',
      cwd: '/managed/app/topic',
      executionHostId: 'runtime:remote'
    }),
    makeSession({ id: 'prior', cwd: '/prior/topic' })
  ]
  const rows = buildAiVaultSessionProjectById({
    repos,
    projectHostSetupProjection: projection,
    sessions,
    worktrees: [
      makeWorktree({
        id: 'same::/current',
        repoId: 'same',
        hostId: 'local',
        path: '/current',
        priorWorktreeIds: ['same::/prior']
      })
    ],
    settings: { workspaceDir: '/managed', nestWorkspaces: true }
  })
  expect([...rows.values()].map((row) => row.key)).toEqual(['repo:same', 'repo:same', 'repo:same'])
})

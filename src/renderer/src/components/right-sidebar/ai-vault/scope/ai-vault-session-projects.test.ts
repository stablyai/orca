import { describe, expect, it } from 'vitest'
import type { ProjectHostSetupProjection } from '../../../../../../shared/project-host-setup-projection'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { Project, ProjectHostSetup } from '../../../../../../shared/project-types'

import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

import {
  buildAiVaultProjectContext,
  buildAiVaultSessionProjectById
} from './ai-vault-session-projects'

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

describe('buildAiVaultProjectContext', () => {
  it('uses durable worktree project ids before repo fallback', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Legacy Repo', path: '/Users/ada/orca' })
    const project = makeProject({ id: 'project-1', displayName: 'Canonical Orca' })
    const worktree = makeWorktree({
      id: 'wt-1',
      repoId: repo.id,
      projectId: project.id,
      path: '/Users/ada/orca'
    })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [worktree],
      projectHostSetupProjection: makeProjection({
        projects: [project],
        setups: [makeSetup({ repoId: repo.id, projectId: project.id, path: repo.path })]
      }),
      activeRepo: repo,
      activeWorktree: worktree,
      sessions: [baseSession]
    })

    expect(context.activeProjectKey).toBe('project:project-1')
    expect(context.sessionProjectById.get(baseSession.id)).toMatchObject({
      kind: 'repo',
      key: 'project:project-1',
      label: 'Canonical Orca'
    })
  })

  it('inherits setup project ids for legacy worktrees without project metadata', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Orca Repo', path: '/repo/orca' })
    const worktree = makeWorktree({
      id: 'wt-legacy',
      repoId: repo.id,
      path: '/repo/orca'
    })
    const session = makeSession({ id: 'claude:legacy-worktree', cwd: '/repo/orca/src' })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [worktree],
      projectHostSetupProjection: makeProjection({
        projects: [makeProject({ id: 'github:stablyai/orca', displayName: 'Canonical Orca' })],
        setups: [
          makeSetup({
            repoId: repo.id,
            projectId: 'github:stablyai/orca',
            path: repo.path
          })
        ]
      }),
      activeRepo: repo,
      activeWorktree: worktree,
      sessions: [session]
    })

    expect(context.activeProjectKey).toBe('project:github:stablyai/orca')
    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      kind: 'repo',
      key: 'project:github:stablyai/orca',
      label: 'Canonical Orca'
    })
  })

  it('inherits setup host ids for legacy worktrees without host metadata', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Runtime Repo', path: '/runtime/orca' })
    const worktree = makeWorktree({
      id: 'wt-runtime',
      repoId: repo.id,
      path: '/runtime/orca'
    })
    const session = makeSession({
      id: 'claude:runtime-worktree',
      cwd: '/runtime/orca/src',
      executionHostId: 'runtime:preview'
    })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [worktree],
      projectHostSetupProjection: makeProjection({
        projects: [makeProject({ id: 'project-runtime', displayName: 'Runtime Project' })],
        setups: [
          makeSetup({
            repoId: repo.id,
            projectId: 'project-runtime',
            path: repo.path,
            hostId: 'runtime:preview'
          })
        ]
      }),
      activeRepo: repo,
      activeWorktree: worktree,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      kind: 'repo',
      key: 'project:project-runtime',
      hostKey: 'runtime:preview'
    })
  })

  it('chooses the most specific nested path and lets worktrees win equal-length ties', () => {
    const repo = makeRepo({ id: 'repo-root', displayName: 'Root', path: '/repo' })
    const childRepo = makeRepo({ id: 'repo-child', displayName: 'Child Repo', path: '/repo/pkg' })
    const worktree = makeWorktree({
      id: 'wt-child',
      repoId: childRepo.id,
      projectId: 'child-project',
      path: '/repo/pkg'
    })
    const session = makeSession({ id: 'claude:nested', cwd: '/repo/pkg/src' })

    const context = buildAiVaultProjectContext({
      repos: [repo, childRepo],
      worktrees: [worktree],
      projectHostSetupProjection: makeProjection({
        projects: [makeProject({ id: 'child-project', displayName: 'Child Project' })],
        setups: [
          makeSetup({ repoId: repo.id, projectId: 'root-project', path: repo.path }),
          makeSetup({ repoId: childRepo.id, projectId: 'setup-child', path: childRepo.path })
        ]
      }),
      activeRepo: childRepo,
      activeWorktree: worktree,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      key: 'project:child-project',
      label: 'Child Project'
    })
  })

  it('uses the session host when matching overlapping local and SSH project paths', () => {
    const localRepo = makeRepo({ id: 'local', displayName: 'Local', path: '/srv/orca' })
    const sshRepo = makeRepo({
      id: 'ssh',
      displayName: 'SSH',
      path: '/srv/orca',
      connectionId: 'target-1'
    })
    const session = makeSession({
      id: 'claude:ssh-session',
      cwd: '/srv/orca/src',
      executionHostId: 'ssh:target-1'
    })

    const context = buildAiVaultProjectContext({
      repos: [localRepo, sshRepo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({
        projects: [],
        setups: [
          makeSetup({ repoId: localRepo.id, projectId: 'repo:local', path: localRepo.path }),
          makeSetup({
            repoId: sshRepo.id,
            projectId: 'repo:ssh',
            path: sshRepo.path,
            hostId: 'ssh:target-1',
            connectionId: 'target-1'
          })
        ]
      }),
      activeRepo: localRepo,
      activeWorktree: null,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      kind: 'repo',
      key: 'repo:ssh',
      label: 'SSH',
      hostKey: 'ssh:target-1'
    })
  })

  it('falls back to folder when a legacy hostless session matches multiple host buckets', () => {
    const localRepo = makeRepo({ id: 'local', displayName: 'Local', path: '/srv/orca' })
    const runtimeRepo = makeRepo({ id: 'runtime', displayName: 'Runtime', path: '/srv/orca' })
    const session = makeSession({
      id: 'claude:runtime-ambiguous',
      cwd: '/srv/orca/src',
      executionHostId: undefined as unknown as AiVaultSession['executionHostId']
    })

    const context = buildAiVaultProjectContext({
      repos: [localRepo, runtimeRepo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({
        projects: [],
        setups: [
          makeSetup({ repoId: localRepo.id, projectId: 'repo:local', path: localRepo.path }),
          makeSetup({
            repoId: runtimeRepo.id,
            projectId: 'repo:runtime',
            path: runtimeRepo.path,
            hostId: 'runtime:preview'
          })
        ]
      }),
      activeRepo: localRepo,
      activeWorktree: null,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      kind: 'folder',
      key: 'folder:/srv/orca/src',
      label: 'orca/src'
    })
  })

  it('ignores blank setup paths instead of treating them as catch-all candidates', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Repo', path: '/repo' })
    const session = makeSession({ id: 'claude:outside', cwd: '/outside/path' })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({
        projects: [],
        setups: [makeSetup({ repoId: repo.id, projectId: 'repo:repo-1', path: '' })]
      }),
      activeRepo: repo,
      activeWorktree: null,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      kind: 'folder',
      key: 'folder:/outside/path',
      label: 'outside/path'
    })
  })

  it('uses repo fallback candidates when a setup for the repo has a blank path', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Repo', path: '/repo' })
    const session = makeSession({ id: 'claude:inside-repo', cwd: '/repo/src' })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({
        projects: [],
        setups: [makeSetup({ repoId: repo.id, projectId: 'repo:repo-1', path: '' })]
      }),
      activeRepo: repo,
      activeWorktree: null,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      kind: 'repo',
      key: 'repo:repo-1',
      label: 'Repo'
    })
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

function makeProject(overrides: Partial<Project>): Project {
  return {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#737373',
    sourceRepoIds: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeSetup(overrides: Partial<ProjectHostSetup>): ProjectHostSetup {
  return {
    id: overrides.repoId ?? 'setup-1',
    projectId: 'project-1',
    hostId: 'local',
    repoId: 'repo-1',
    path: '/Users/ada/orca',
    displayName: 'Orca',
    setupState: 'ready',
    setupMethod: 'legacy-repo',
    createdAt: 1,
    updatedAt: 1,
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

function makeProjection(
  overrides: Partial<ProjectHostSetupProjection>
): ProjectHostSetupProjection {
  return {
    projects: [],
    setups: [],
    ...overrides
  }
}

describe('AI vault session project attribution reuse', () => {
  it('gives sessions on one host distinct attribution per cwd', () => {
    const repos = [
      makeRepo({ id: 'repo-a', path: '/repo-a' }),
      makeRepo({ id: 'repo-b', path: '/repo-b' })
    ]
    const result = buildAiVaultSessionProjectById({
      repos,
      worktrees: [],
      projectHostSetupProjection: makeProjection({}),
      sessions: [
        { ...baseSession, id: 'a1', cwd: '/repo-a/sub' },
        { ...baseSession, id: 'b1', cwd: '/repo-b/sub' },
        { ...baseSession, id: 'a2', cwd: '/repo-a/other' },
        { ...baseSession, id: 'none', cwd: '/elsewhere/sub' }
      ]
    })

    expect(result.get('a1')?.key).toBe('repo:repo-a')
    expect(result.get('a2')?.key).toBe('repo:repo-a')
    expect(result.get('b1')?.key).toBe('repo:repo-b')
    expect(result.get('none')?.kind).toBe('folder')
  })
})

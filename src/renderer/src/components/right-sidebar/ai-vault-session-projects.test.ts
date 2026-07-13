import { describe, expect, it } from 'vitest'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Project, ProjectHostSetup, Repo, Worktree } from '../../../../shared/types'
import { buildAiVaultProjectContext, toAiVaultProjectKey } from './ai-vault-session-projects'

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

describe('toAiVaultProjectKey', () => {
  it('does not double-wrap compatibility repo project ids', () => {
    expect(toAiVaultProjectKey('project-1', 'repo-1')).toBe('project:project-1')
    expect(toAiVaultProjectKey('repo:repo-1', 'repo-1')).toBe('repo:repo-1')
    expect(toAiVaultProjectKey(null, 'repo-1')).toBe('repo:repo-1')
  })
})

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

  it('normalizes compatibility project ids to repo keys', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Orca', path: '/Users/ada/orca' })
    const worktree = makeWorktree({
      id: 'wt-1',
      repoId: repo.id,
      projectId: 'repo:repo-1',
      path: '/Users/ada/orca'
    })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [worktree],
      projectHostSetupProjection: makeProjection({
        projects: [makeProject({ id: 'repo:repo-1', displayName: 'Compatibility Orca' })],
        setups: [makeSetup({ repoId: repo.id, projectId: 'repo:repo-1', path: repo.path })]
      }),
      activeRepo: repo,
      activeWorktree: worktree,
      sessions: [baseSession]
    })

    expect(context.activeProjectKey).toBe('repo:repo-1')
    expect(context.sessionProjectById.get(baseSession.id)?.key).toBe('repo:repo-1')
    expect(context.projectLabelByKey.get('repo:repo-1')).toBe('Orca')
  })

  it('falls back to repo ids for legacy records without project metadata', () => {
    const repo = makeRepo({ id: 'repo-legacy', displayName: 'Legacy', path: '/repo/legacy' })
    const session = makeSession({ id: 'codex:legacy', cwd: '/repo/legacy/src' })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({ projects: [], setups: [] }),
      activeRepo: repo,
      activeWorktree: null,
      sessions: [session]
    })

    expect(context.activeProjectKey).toBe('repo:repo-legacy')
    expect(context.sessionProjectById.get(session.id)).toMatchObject({
      kind: 'repo',
      key: 'repo:repo-legacy',
      label: 'Legacy'
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

  it('uses active worktree setup project ids when active repo is unavailable', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Orca Repo', path: '/repo/orca' })
    const worktree = makeWorktree({
      id: 'wt-restored',
      repoId: repo.id,
      path: '/repo/orca'
    })
    const session = makeSession({ id: 'claude:restored', cwd: '/repo/orca/src' })

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
      activeRepo: null,
      activeWorktree: worktree,
      sessions: [session]
    })

    expect(context.activeProjectKey).toBe('project:github:stablyai/orca')
    expect(context.sessionProjectById.get(session.id)?.key).toBe('project:github:stablyai/orca')
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

  it('keeps project labels canonical instead of using first matched session order', () => {
    const repoA = makeRepo({ id: 'repo-a', displayName: 'Fork Checkout', path: '/work/fork' })
    const repoB = makeRepo({ id: 'repo-b', displayName: 'Main Checkout', path: '/work/main' })
    const project = makeProject({ id: 'project-1', displayName: 'Canonical Project' })
    const firstSession = makeSession({ id: 'claude:first', cwd: '/work/fork/src' })
    const secondSession = makeSession({ id: 'codex:second', cwd: '/work/main/src' })

    const context = buildAiVaultProjectContext({
      repos: [repoA, repoB],
      worktrees: [],
      projectHostSetupProjection: makeProjection({
        projects: [project],
        setups: [
          makeSetup({ repoId: repoA.id, projectId: project.id, path: repoA.path }),
          makeSetup({ repoId: repoB.id, projectId: project.id, path: repoB.path })
        ]
      }),
      activeRepo: repoA,
      activeWorktree: null,
      sessions: [firstSession, secondSession]
    })

    expect(context.projectLabelByKey.get('project:project-1')).toBe('Canonical Project')
    expect(context.sessionProjectById.get(firstSession.id)?.label).toBe('Canonical Project')
    expect(context.sessionProjectById.get(secondSession.id)?.label).toBe('Canonical Project')
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

  it('matches Windows paths case-insensitively across separators', () => {
    const repo = makeRepo({
      id: 'repo-win',
      displayName: 'Windows Repo',
      path: 'C:\\Users\\Ada\\Repo'
    })
    const session = makeSession({ id: 'claude:win', cwd: 'c:/users/ada/repo/src' })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({
        projects: [],
        setups: [makeSetup({ repoId: repo.id, projectId: 'repo:repo-win', path: repo.path })]
      }),
      activeRepo: repo,
      activeWorktree: null,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)?.key).toBe('repo:repo-win')
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

  it('maps null cwd sessions to unknown', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Orca', path: '/repo' })
    const session = makeSession({ id: 'claude:unknown', cwd: null })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({ projects: [], setups: [] }),
      activeRepo: repo,
      activeWorktree: null,
      sessions: [session]
    })

    expect(context.sessionProjectById.get(session.id)).toEqual({
      kind: 'unknown',
      key: 'unknown',
      label: ''
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

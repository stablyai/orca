import { describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import * as paths from '../../../../shared/cross-platform-path'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  buildAiVaultProjectContext,
  buildAiVaultSessionProjectById
} from './ai-vault-session-projects'
import { truncateAiVaultListResult } from '../../../../shared/ai-vault-session-depth'
import {
  groupAiVaultSessions,
  filterAiVaultSessions
} from '../../../../shared/ai-vault-session-filters'

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

  it('keeps the most specific workspace path while using its current checkout affiliation', () => {
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
        projects: [makeProject({ id: 'setup-child', displayName: 'Child Project' })],
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
      key: 'project:setup-child',
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

  it('emits a folder project key the shared folder grouping falls back to', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Repo', path: '/repo' })
    const resolved = makeSession({ id: 'claude:resolved', cwd: '/outside/path' })
    const unresolved = makeSession({ id: 'claude:unresolved', cwd: '/outside/path/' })

    const context = buildAiVaultProjectContext({
      repos: [repo],
      worktrees: [],
      projectHostSetupProjection: makeProjection({ projects: [], setups: [] }),
      activeRepo: repo,
      activeWorktree: null,
      sessions: [resolved]
    })

    // Both key builders must agree, or one folder shows two identically labelled headers.
    const groups = groupAiVaultSessions([resolved, unresolved], 'project', {
      sessionProjectById: context.sessionProjectById
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].sessions.map((session) => session.id)).toEqual([
      'claude:resolved',
      'claude:unresolved'
    ])
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

describe('buildAiVaultSessionProjectById', () => {
  it('produces the exact context map without reading the active repo/worktree', () => {
    const repoA = makeRepo({ id: 'repo-a', displayName: 'Alpha', path: '/Users/ada/alpha' })
    const repoB = makeRepo({ id: 'repo-b', displayName: 'Beta', path: '/Users/ada/beta' })
    const worktreeA = makeWorktree({ id: 'wt-a', repoId: repoA.id, path: '/Users/ada/alpha' })
    const worktreeB = makeWorktree({ id: 'wt-b', repoId: repoB.id, path: '/Users/ada/beta' })
    const shared = {
      repos: [repoA, repoB],
      worktrees: [worktreeA, worktreeB],
      projectHostSetupProjection: makeProjection({}),
      sessions: [
        makeSession({ id: 'claude:a', cwd: '/Users/ada/alpha/src' }),
        makeSession({ id: 'claude:b', cwd: '/Users/ada/beta' }),
        makeSession({ id: 'claude:none', cwd: '/Users/ada/elsewhere' })
      ]
    }

    const standalone = buildAiVaultSessionProjectById(shared)

    for (const [activeRepo, activeWorktree] of [
      [repoA, worktreeA],
      [repoB, worktreeB],
      [null, null]
    ] as const) {
      expect(standalone).toEqual(
        buildAiVaultProjectContext({ ...shared, activeRepo, activeWorktree }).sessionProjectById
      )
    }
  })

  it('attributes non-ASCII cwds across unicode normalization forms', () => {
    const repo = makeRepo({ id: 'repo-1', displayName: 'Café', path: '/Users/ada/caf\u00e9' })
    const worktree = makeWorktree({ id: 'wt-1', repoId: repo.id, path: '/Users/ada/caf\u00e9' })

    const map = buildAiVaultSessionProjectById({
      repos: [repo],
      worktrees: [worktree],
      projectHostSetupProjection: makeProjection({}),
      sessions: [makeSession({ id: 'claude:nfd', cwd: '/Users/ada/cafe\u0301/src' })]
    })

    expect(map.get('claude:nfd')).toMatchObject({ kind: 'repo', key: 'repo:repo-1' })
  })
  it('attributes a real-path session to the symlinked workspace its host alias names', () => {
    const parent = makeRepo({ id: 'parent', displayName: 'Work', path: '/Users/ada/work' })
    const child = makeRepo({ id: 'child', displayName: 'Api', path: '/Users/ada/work/api' })
    const map = buildAiVaultSessionProjectById({
      repos: [parent, child],
      worktrees: [
        makeWorktree({ id: 'wt-parent', repoId: parent.id, path: parent.path }),
        makeWorktree({ id: 'wt-child', repoId: child.id, path: child.path })
      ],
      projectHostSetupProjection: makeProjection({}),
      sessions: [
        makeSession({
          id: 'claude:linked',
          cwd: '/data/src/api/pkg',
          cwdAliases: ['/Users/ada/work/api/pkg']
        })
      ]
    })

    expect(map.get('claude:linked')).toMatchObject({ kind: 'repo', key: 'repo:child' })
  })

  it('keeps a nested project over a longer-spelled parent link that reaches it through an alias', () => {
    const parent = makeRepo({
      id: 'parent',
      displayName: 'Parent',
      path: '/a-very-long-parent-link'
    })
    const child = makeRepo({ id: 'child', displayName: 'Child', path: '/real/child' })
    const map = buildAiVaultSessionProjectById({
      repos: [parent, child],
      worktrees: [
        makeWorktree({ id: 'wt-parent', repoId: parent.id, path: parent.path }),
        makeWorktree({ id: 'wt-child', repoId: child.id, path: child.path })
      ],
      projectHostSetupProjection: makeProjection({}),
      sessions: [
        makeSession({
          id: 'claude:nested',
          cwd: '/real/child/pkg',
          cwdAliases: ['/a-very-long-parent-link/child/pkg']
        })
      ]
    })

    expect(map.get('claude:nested')).toMatchObject({ kind: 'repo', key: 'repo:child' })
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
  it('shares project attribution only within the same host and raw cwd during one build', () => {
    const repos = Array.from({ length: 200 }, (_, i) =>
      makeRepo({ id: `repo-${i}`, path: `/repo-${i}` })
    )
    const sessions = Array.from({ length: 1000 }, (_, i) => ({
      ...baseSession,
      id: String(i),
      cwd: '/repo-199/sub'
    }))
    let comparisons = 0
    const original = paths.createNormalizedPathInsideOrEqualMatcher
    const spy = vi
      .spyOn(paths, 'createNormalizedPathInsideOrEqualMatcher')
      .mockImplementation((root) => {
        const matches = original(root)
        return (cwd) => {
          comparisons++
          return matches(cwd)
        }
      })
    let result: ReturnType<typeof buildAiVaultSessionProjectById>
    try {
      result = buildAiVaultSessionProjectById({
        repos,
        worktrees: [],
        projectHostSetupProjection: { projects: [], setups: [] },
        sessions
      })
      expect(comparisons).toBe(200)
    } finally {
      spy.mockRestore()
    }
    expect(result.get('0')?.key).toBe('repo:repo-199')
    expect(result.get('0')).toEqual(result.get('999'))
    expect(result.get('0')).not.toBe(result.get('999'))
    const hosts = buildAiVaultSessionProjectById({
      repos,
      worktrees: [],
      projectHostSetupProjection: { projects: [], setups: [] },
      sessions: [sessions[0], { ...sessions[0], id: 'remote', executionHostId: 'ssh:other' }]
    })
    expect(hosts.get('remote')?.kind).toBe('folder')
  })

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

  it('keys on the raw cwd so equivalent spellings still resolve correctly', () => {
    // Raw spellings intentionally miss one another's cache entries; recomputation remains correct.
    const repos = [makeRepo({ id: 'repo-win', path: 'C:\\Users\\Ada\\repo' })]
    const result = buildAiVaultSessionProjectById({
      repos,
      worktrees: [],
      projectHostSetupProjection: makeProjection({}),
      sessions: [
        { ...baseSession, id: 'back', cwd: 'C:\\Users\\Ada\\repo\\app' },
        { ...baseSession, id: 'fwd', cwd: 'c:/users/ada/repo/app' },
        { ...baseSession, id: 'trail', cwd: 'C:/Users/Ada/repo/app/' }
      ]
    })

    for (const id of ['back', 'fwd', 'trail']) {
      expect({ id, key: result.get(id)?.key }).toEqual({ id, key: 'repo:repo-win' })
    }
  })

  it('separates sessions that carry no cwd from sessions that do', () => {
    const result = buildAiVaultSessionProjectById({
      repos: [makeRepo({ id: 'repo-a', path: '/repo-a' })],
      worktrees: [],
      projectHostSetupProjection: makeProjection({}),
      sessions: [
        { ...baseSession, id: 'empty', cwd: '' },
        { ...baseSession, id: 'real', cwd: '/repo-a/sub' }
      ]
    })

    expect(result.get('empty')?.kind).toBe('unknown')
    expect(result.get('real')?.key).toBe('repo:repo-a')
  })
})

it('keeps WSL distro identity through project memoization, Workspace filtering and cache depth', () => {
  const scope = String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`
  const repo = makeRepo({ id: 'ubuntu', path: scope })
  const sessions = ['Debian', 'Ubuntu'].map((distro) =>
    makeSession({
      id: distro,
      cwd: '/home/ada/repo/src',
      filePath: `//wsl$/${distro}/home/ada/session.jsonl`
    })
  )
  const projects = buildAiVaultSessionProjectById({
    repos: [repo],
    worktrees: [],
    projectHostSetupProjection: makeProjection({}),
    sessions
  })
  expect(projects.get('Debian')?.kind).toBe('folder')
  expect(projects.get('Ubuntu')?.key).toBe('repo:ubuntu')
  const loaded = {
    sessions: [makeSession({ id: 'global', cwd: '/other' }), ...sessions],
    issues: [],
    scannedAt: '2026-10-10T00:00:00.000Z'
  }
  for (const depth of [2, 1]) {
    const trimmed = truncateAiVaultListResult(loaded, depth, [scope])
    expect(
      filterAiVaultSessions(trimmed.sessions, {
        query: '',
        agents: ['claude'],
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePaths: [scope],
        hideEmptySessions: true
      }).map((row) => row.id)
    ).toEqual(['Ubuntu'])
  }
  expect(
    filterAiVaultSessions(sessions, {
      query: '',
      agents: ['claude'],
      scope: 'project',
      sort: 'updated',
      activeWorktreePaths: [scope],
      activeProjectKey: 'repo:ubuntu',
      sessionProjectById: projects,
      hideEmptySessions: true
    }).map((row) => row.id)
  ).toEqual(['Ubuntu'])
})

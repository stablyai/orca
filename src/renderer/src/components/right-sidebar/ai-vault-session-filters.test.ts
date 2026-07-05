import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES,
  filterAiVaultSessions,
  folderLabel,
  groupAiVaultSessions,
  isAiVaultSessionFilterQueryTooLarge,
  parseVaultQuery
} from './ai-vault-session-filters'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from './ai-vault-scope-paths'

const baseSession: AiVaultSession = {
  id: 'claude:1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'session-1',
  title: 'Implement vault filters',
  cwd: '/Users/ada/repo/app',
  branch: 'feature/vault',
  model: 'claude-sonnet-4-5',
  filePath: '/Users/ada/.claude/projects/session-1.jsonl',
  codexHome: null,
  createdAt: '2026-05-01T10:00:00.000Z',
  updatedAt: '2026-05-01T10:10:00.000Z',
  modifiedAt: '2026-05-01T10:10:00.000Z',
  messageCount: 4,
  totalTokens: 1200,
  previewMessages: [],
  resumeCommand: "cd '/Users/ada/repo/app' && claude --resume 'session-1'"
}

describe('filterAiVaultSessions', () => {
  it('filters by workspace, agent, plain terms, repo: and path: operators', () => {
    const sessions: AiVaultSession[] = [
      baseSession,
      {
        ...baseSession,
        id: 'codex:2',
        agent: 'codex',
        sessionId: 'session-2',
        title: 'Repair terminal tabs',
        cwd: '/Users/ada/other/packages/ui',
        branch: 'fix/terminal',
        filePath: '/Users/ada/.codex/sessions/session-2.jsonl'
      }
    ]

    expect(
      filterAiVaultSessions(sessions, {
        query: 'vault repo:repo path:app',
        agents: ['claude'],
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePaths: ['/Users/ada/repo'],
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:1'])
  })

  it('matches workspace sessions under prior renamed worktree paths', () => {
    const sessions: AiVaultSession[] = [
      {
        ...baseSession,
        id: 'claude:old-path',
        cwd: '/Users/ada/workspaces/orca/bream/src'
      },
      {
        ...baseSession,
        id: 'claude:other-path',
        cwd: '/Users/ada/workspaces/other/bream'
      }
    ]

    expect(
      filterAiVaultSessions(sessions, {
        query: '',
        agents: ['claude'],
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePaths: [
          '/Users/ada/workspaces/orca/fix-agent-history',
          '/Users/ada/workspaces/orca/bream'
        ],
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:old-path'])
  })

  it('returns no workspace matches when active workspace paths are empty', () => {
    expect(
      filterAiVaultSessions([baseSession], {
        query: '',
        agents: ['claude'],
        scope: 'workspace',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true
      })
    ).toEqual([])
  })

  it('hides empty metadata-only sessions when requested', () => {
    const emptySession: AiVaultSession = {
      ...baseSession,
      id: 'claude:empty',
      sessionId: 'empty-session',
      title: 'Claude empty-session',
      messageCount: 0
    }

    expect(
      filterAiVaultSessions([emptySession, baseSession], {
        query: '',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:1'])

    const shownWhenAllowed = filterAiVaultSessions([emptySession, baseSession], {
      query: '',
      agents: ['claude'],
      scope: 'all',
      sort: 'updated',
      activeWorktreePaths: [],
      hideEmptySessions: false
    }).map((session) => session.id)

    expect(new Set(shownWhenAllowed)).toEqual(new Set(['claude:1', 'claude:empty']))
  })

  it('matches visible preview message text', () => {
    expect(
      filterAiVaultSessions(
        [
          {
            ...baseSession,
            previewMessages: [
              {
                role: 'assistant',
                text: 'The fixture ordering now matches the golden output.',
                timestamp: null
              }
            ]
          }
        ],
        {
          query: 'fixture ordering',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true
        }
      ).map((session) => session.id)
    ).toEqual(['claude:1'])
  })

  it('does not match hidden preview text when conversation turns are visible', () => {
    expect(
      filterAiVaultSessions(
        [
          {
            ...baseSession,
            previewMessages: [
              {
                role: 'user',
                text: 'Please repair the screenshot comparison.',
                timestamp: null
              },
              {
                role: 'tool',
                text: 'internal-build-cache-token',
                timestamp: null
              }
            ]
          }
        ],
        {
          query: 'internal-build-cache-token',
          agents: ['claude'],
          scope: 'all',
          sort: 'updated',
          activeWorktreePaths: [],
          hideEmptySessions: true
        }
      )
    ).toEqual([])
  })

  it('matches Windows workspace paths case-insensitively', () => {
    expect(
      filterAiVaultSessions(
        [
          {
            ...baseSession,
            cwd: 'C:\\Users\\Ada\\Repo\\App'
          }
        ],
        {
          query: '',
          agents: ['claude'],
          scope: 'workspace',
          sort: 'updated',
          activeWorktreePaths: ['c:\\users\\ada\\repo'],
          hideEmptySessions: true
        }
      )
    ).toHaveLength(1)
  })

  it('matches WSL UNC workspace paths against Linux session cwd values', () => {
    expect(
      filterAiVaultSessions(
        [
          {
            ...baseSession,
            cwd: '/home/ada/repo/app'
          }
        ],
        {
          query: '',
          agents: ['claude'],
          scope: 'workspace',
          sort: 'updated',
          activeWorktreePaths: [String.raw`\\wsl.localhost\Ubuntu\home\ada\repo`],
          hideEmptySessions: true
        }
      )
    ).toHaveLength(1)
  })

  it('returns no sessions for oversized pasted queries before reading session fields', () => {
    const unreadableSession = { ...baseSession }
    Object.defineProperty(unreadableSession, 'agent', {
      get() {
        throw new Error('session should not be scanned')
      }
    })

    expect(
      filterAiVaultSessions([unreadableSession], {
        query: 'x'.repeat(AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES + 1),
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        hideEmptySessions: false
      })
    ).toEqual([])
  })

  it('filters project scope by the resolved active project key', () => {
    const projectSession = { ...baseSession, id: 'claude:project', cwd: '/repo/project' }
    const otherSession = { ...baseSession, id: 'claude:other', cwd: '/repo/other' }
    const sessionProjectById = new Map([
      [projectSession.id, { kind: 'repo' as const, key: 'project:orca', label: 'Orca' }],
      [otherSession.id, { kind: 'repo' as const, key: 'project:other', label: 'Other' }]
    ])

    expect(
      filterAiVaultSessions([projectSession, otherSession], {
        query: '',
        agents: ['claude'],
        scope: 'project',
        sort: 'updated',
        activeWorktreePaths: [],
        activeProjectKey: 'project:orca',
        sessionProjectById,
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:project'])
  })

  it('does not show all sessions for project scope without an active project key', () => {
    expect(
      filterAiVaultSessions([baseSession], {
        query: '',
        agents: ['claude'],
        scope: 'project',
        sort: 'updated',
        activeWorktreePaths: [],
        activeProjectKey: null,
        hideEmptySessions: true
      })
    ).toEqual([])
  })

  it('matches repo: queries against resolved project labels before folder fallback', () => {
    const sessionProjectById = new Map([
      [baseSession.id, { kind: 'repo' as const, key: 'project:orca', label: 'Canonical Orca' }]
    ])
    const projectLabelByKey = new Map([['project:orca', 'Canonical Orca']])

    expect(
      filterAiVaultSessions([baseSession], {
        query: 'repo:canonical',
        agents: ['claude'],
        scope: 'all',
        sort: 'updated',
        activeWorktreePaths: [],
        sessionProjectById,
        projectLabelByKey,
        hideEmptySessions: true
      }).map((session) => session.id)
    ).toEqual(['claude:1'])
  })
})

describe('deriveAiVaultWorkspaceScopePaths', () => {
  it('includes current and same-repo prior filesystem paths', () => {
    expect(
      deriveAiVaultWorkspaceScopePaths({
        id: 'repo1::/Users/ada/workspaces/orca/fix-agent-history',
        repoId: 'repo1',
        path: '/Users/ada/workspaces/orca/fix-agent-history',
        priorWorktreeIds: ['repo1::/Users/ada/workspaces/orca/bream']
      })
    ).toEqual(['/Users/ada/workspaces/orca/fix-agent-history', '/Users/ada/workspaces/orca/bream'])
  })

  it('strips folder-workspace instance suffixes from prior ids', () => {
    expect(
      deriveAiVaultWorkspaceScopePaths({
        id: 'repo1::/Users/ada/folders/orca',
        repoId: 'repo1',
        path: '/Users/ada/folders/orca',
        priorWorktreeIds: [
          'repo1::/Users/ada/folders/old-orca::workspace:123e4567-e89b-12d3-a456-426614174000'
        ]
      })
    ).toEqual(['/Users/ada/folders/orca', '/Users/ada/folders/old-orca'])
  })

  it('ignores malformed, different-repo, relative, empty, and duplicate aliases', () => {
    expect(
      deriveAiVaultWorkspaceScopePaths({
        id: 'repo1::C:\\Users\\Ada\\Repo',
        repoId: 'repo1',
        path: 'C:\\Users\\Ada\\Repo',
        priorWorktreeIds: [
          'not-a-worktree-id',
          'repo2::C:\\Users\\Ada\\OldRepo',
          'repo1::relative/path',
          'repo1::',
          'repo1::c:\\users\\ada\\repo',
          'repo1::C:\\Users\\Ada\\OldRepo'
        ]
      })
    ).toEqual(['C:\\Users\\Ada\\Repo', 'C:\\Users\\Ada\\OldRepo'])
  })

  it('ignores prior paths claimed by another live worktree in the same repo', () => {
    expect(
      deriveAiVaultWorkspaceScopePaths(
        {
          id: 'repo1::/Users/ada/workspaces/orca/fix-agent-history',
          repoId: 'repo1',
          path: '/Users/ada/workspaces/orca/fix-agent-history',
          priorWorktreeIds: [
            'repo1::/Users/ada/workspaces/orca/bream',
            'repo1::/Users/ada/workspaces/orca/unclaimed-old-path'
          ]
        },
        [
          {
            id: 'repo1::/Users/ada/workspaces/orca/fix-agent-history',
            repoId: 'repo1',
            path: '/Users/ada/workspaces/orca/fix-agent-history'
          },
          {
            id: 'repo1::/Users/ada/workspaces/orca/bream',
            repoId: 'repo1',
            path: '/Users/ada/workspaces/orca/bream'
          }
        ]
      )
    ).toEqual([
      '/Users/ada/workspaces/orca/fix-agent-history',
      '/Users/ada/workspaces/orca/unclaimed-old-path'
    ])
  })

  it('ignores prior paths claimed by another live worktree in a different repo', () => {
    expect(
      deriveAiVaultWorkspaceScopePaths(
        {
          id: 'repo1::/Users/ada/workspaces/orca/fix-agent-history',
          repoId: 'repo1',
          path: '/Users/ada/workspaces/orca/fix-agent-history',
          priorWorktreeIds: [
            'repo1::/Users/ada/workspaces/orca/bream',
            'repo1::/Users/ada/workspaces/orca/unclaimed-old-path'
          ]
        },
        [
          {
            id: 'repo1::/Users/ada/workspaces/orca/fix-agent-history',
            repoId: 'repo1',
            path: '/Users/ada/workspaces/orca/fix-agent-history'
          },
          {
            id: 'repo2::/Users/ada/workspaces/orca/bream',
            repoId: 'repo2',
            path: '/Users/ada/workspaces/orca/bream'
          }
        ]
      )
    ).toEqual([
      '/Users/ada/workspaces/orca/fix-agent-history',
      '/Users/ada/workspaces/orca/unclaimed-old-path'
    ])
  })
})

describe('deriveAiVaultScopeSessionPaths', () => {
  it('adds same-repo sibling worktrees on top of the workspace paths', () => {
    expect(
      deriveAiVaultScopeSessionPaths(
        {
          id: 'repo1::/Users/ada/workspaces/orca/fix-agent-history',
          repoId: 'repo1',
          path: '/Users/ada/workspaces/orca/fix-agent-history',
          priorWorktreeIds: []
        },
        [
          {
            id: 'repo1::/Users/ada/workspaces/orca/fix-agent-history',
            repoId: 'repo1',
            path: '/Users/ada/workspaces/orca/fix-agent-history'
          },
          {
            id: 'repo1::/Users/ada/workspaces/orca/sibling',
            repoId: 'repo1',
            path: '/Users/ada/workspaces/orca/sibling'
          },
          {
            id: 'repo2::/Users/ada/workspaces/other/elsewhere',
            repoId: 'repo2',
            path: '/Users/ada/workspaces/other/elsewhere'
          }
        ]
      )
    ).toEqual([
      '/Users/ada/workspaces/orca/fix-agent-history',
      '/Users/ada/workspaces/orca/sibling'
    ])
  })

  it('returns no paths without an active worktree', () => {
    expect(deriveAiVaultScopeSessionPaths(null, [])).toEqual([])
  })

  it('adds active project setup paths across repos', () => {
    expect(
      deriveAiVaultScopeSessionPaths(
        {
          id: 'repo1::/Users/ada/workspaces/orca/app',
          repoId: 'repo1',
          path: '/Users/ada/workspaces/orca/app',
          priorWorktreeIds: []
        },
        [
          {
            id: 'repo1::/Users/ada/workspaces/orca/app',
            repoId: 'repo1',
            path: '/Users/ada/workspaces/orca/app'
          },
          {
            id: 'repo2::/Users/ada/workspaces/orca/docs',
            repoId: 'repo2',
            path: '/Users/ada/workspaces/orca/docs'
          }
        ],
        {
          activeProjectKey: 'project:orca',
          projectHostSetupProjection: {
            projects: [
              {
                id: 'orca',
                displayName: 'Orca',
                badgeColor: '#2563eb',
                sourceRepoIds: ['repo1', 'repo2'],
                createdAt: 1,
                updatedAt: 1
              }
            ],
            setups: [
              {
                id: 'setup-1',
                projectId: 'orca',
                hostId: 'local',
                repoId: 'repo1',
                displayName: 'App',
                path: '/Users/ada/workspaces/orca/app',
                setupState: 'ready',
                setupMethod: 'imported-existing-folder',
                createdAt: 1,
                updatedAt: 1
              },
              {
                id: 'setup-2',
                projectId: 'orca',
                hostId: 'local',
                repoId: 'repo2',
                displayName: 'Docs',
                path: '/Users/ada/workspaces/orca/docs',
                setupState: 'ready',
                setupMethod: 'imported-existing-folder',
                createdAt: 1,
                updatedAt: 1
              }
            ]
          }
        }
      )
    ).toEqual(['/Users/ada/workspaces/orca/app', '/Users/ada/workspaces/orca/docs'])
  })

  it('keeps live worktree paths when another setup shares the repo id', () => {
    expect(
      deriveAiVaultScopeSessionPaths(
        {
          id: 'repo1::/Users/ada/workspaces/orca/app',
          repoId: 'repo1',
          path: '/Users/ada/workspaces/orca/app',
          priorWorktreeIds: []
        },
        [
          {
            id: 'repo2::/Users/ada/workspaces/orca/docs-worktree',
            repoId: 'repo2',
            path: '/Users/ada/workspaces/orca/docs-worktree'
          }
        ],
        {
          activeProjectKey: 'project:orca',
          projectHostSetupProjection: {
            projects: [
              {
                id: 'orca',
                displayName: 'Orca',
                badgeColor: '#2563eb',
                sourceRepoIds: ['repo1', 'repo2'],
                createdAt: 1,
                updatedAt: 1
              }
            ],
            setups: [
              {
                id: 'setup-1',
                projectId: 'orca',
                hostId: 'local',
                repoId: 'repo2',
                displayName: 'Docs',
                path: '/Users/ada/workspaces/orca/docs',
                setupState: 'ready',
                setupMethod: 'imported-existing-folder',
                createdAt: 1,
                updatedAt: 1
              },
              {
                id: 'setup-2',
                projectId: 'other',
                hostId: 'local',
                repoId: 'repo2',
                displayName: 'Other',
                path: '/Users/ada/workspaces/other',
                setupState: 'ready',
                setupMethod: 'imported-existing-folder',
                createdAt: 1,
                updatedAt: 1
              }
            ]
          }
        }
      )
    ).toEqual([
      '/Users/ada/workspaces/orca/app',
      '/Users/ada/workspaces/orca/docs-worktree',
      '/Users/ada/workspaces/orca/docs'
    ])
  })
})

describe('isAiVaultSessionFilterQueryTooLarge', () => {
  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    expect(
      isAiVaultSessionFilterQueryTooLarge(
        'é'.repeat(AI_VAULT_SESSION_FILTER_QUERY_MAX_BYTES / 2 + 1)
      )
    ).toBe(true)
  })
})

describe('groupAiVaultSessions', () => {
  it('groups by folder or agent without changing session order', () => {
    const sessions: AiVaultSession[] = [
      baseSession,
      { ...baseSession, id: 'codex:2', agent: 'codex', cwd: '/Users/ada/repo/app' }
    ]

    expect(groupAiVaultSessions(sessions, 'folder')).toEqual([
      { key: '/users/ada/repo/app', label: 'repo/app', sessions }
    ])
    expect(groupAiVaultSessions(sessions, 'agent').map((group) => group.label)).toEqual([
      'Claude',
      'Codex'
    ])
  })

  it('groups sibling worktree sessions by project label when resolved', () => {
    const sessions: AiVaultSession[] = [
      { ...baseSession, id: 'claude:1', cwd: '/repo/main' },
      { ...baseSession, id: 'codex:2', agent: 'codex', cwd: '/repo/worktree' }
    ]
    const sessionProjectById = new Map(
      sessions.map((session) => [
        session.id,
        { kind: 'repo' as const, key: 'project:orca', label: 'Orca' }
      ])
    )
    const projectLabelByKey = new Map([['project:orca', 'Canonical Orca']])

    expect(
      groupAiVaultSessions(sessions, 'project', {
        sessionProjectById,
        projectLabelByKey
      })
    ).toEqual([{ key: 'project:orca', label: 'Canonical Orca', sessions }])
  })

  it('falls back to folder grouping when project metadata is unavailable', () => {
    expect(groupAiVaultSessions([baseSession], 'project')).toEqual([
      { key: '/users/ada/repo/app', label: 'repo/app', sessions: [baseSession] }
    ])
  })
})

describe('parseVaultQuery', () => {
  it('keeps quoted terms together', () => {
    expect(parseVaultQuery('"resume picker" repo:orca path:src')).toEqual({
      terms: ['resume picker'],
      repoTerms: ['orca'],
      pathTerms: ['src']
    })
  })
})

describe('folderLabel', () => {
  it('uses the last two path segments for compact labels', () => {
    expect(folderLabel('C:\\Users\\Ada\\repo\\app')).toBe('repo/app')
  })
})

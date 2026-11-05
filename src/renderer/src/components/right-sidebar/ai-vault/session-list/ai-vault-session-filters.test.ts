import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import './ai-vault-session-filters'
import { filterAiVaultSessions } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from '../../../../../../shared/ai-vault/scanning/ai-vault-scope-paths'

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
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "cd '/Users/ada/repo/app' && claude --resume 'session-1'",
  subagent: null
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
})

describe('deriveAiVaultScopeSessionPaths', () => {
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

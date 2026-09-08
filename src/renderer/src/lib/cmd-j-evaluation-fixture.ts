import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'

/**
 * Anonymized Cmd+J corpus used as the evaluation gate for the multi-keyword
 * matcher. Names, identifiers, and titles are synthetic; the shapes (automation
 * provenance, linked work items, ports, reviews, Unicode) mirror real workspaces.
 */
export const CMD_J_FIXTURE_REPOS: Repo[] = [
  {
    id: 'repo-orca',
    path: '/repos/orca',
    displayName: 'acme/orca',
    badgeColor: '#22c55e',
    addedAt: 0
  },
  {
    id: 'repo-atlas',
    path: '/repos/atlas',
    displayName: 'acme/atlas',
    badgeColor: '#3b82f6',
    addedAt: 0
  },
  {
    id: 'repo-relay',
    path: '/repos/relay',
    displayName: 'contrib/relay',
    badgeColor: '#f97316',
    addedAt: 0
  }
]

export const CMD_J_FIXTURE_REPO_MAP: ReadonlyMap<string, Repo> = new Map(
  CMD_J_FIXTURE_REPOS.map((repo) => [repo.id, repo])
)

function worktree(overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'repoId'>): Worktree {
  return {
    path: `/work/${overrides.id}`,
    head: 'aaaaaaa',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const AUTOMATION_BASE = {
  kind: 'created-by-automation',
  automationId: 'auto-1',
  executionTargetType: 'local',
  executionTargetId: 'repo-orca',
  projectId: 'project-1'
} as const

export const CMD_J_FIXTURE_WORKTREES: Worktree[] = [
  worktree({
    id: 'wt-scan-daily',
    repoId: 'repo-orca',
    displayName: 'scan daily 1.4.182 · 2026-08-13 · 93334dc',
    branch: 'refs/heads/automation/scan-daily-182',
    automationProvenance: {
      ...AUTOMATION_BASE,
      automationNameSnapshot: 'Nightly review',
      automationRunId: 'run-184',
      automationRunTitleSnapshot: 'Scan daily sweep',
      createdAt: Date.UTC(2026, 7, 13, 4, 0, 0)
    }
  }),
  worktree({
    id: 'wt-scan-daily-older',
    repoId: 'repo-orca',
    displayName: 'scan daily 1.4.181 · 2026-08-12 · 1122334',
    branch: 'refs/heads/automation/scan-daily-181',
    automationProvenance: {
      ...AUTOMATION_BASE,
      automationNameSnapshot: 'Nightly review',
      automationRunId: 'run-183',
      automationRunTitleSnapshot: 'Scan daily sweep',
      createdAt: Date.UTC(2026, 7, 12, 4, 0, 0)
    }
  }),
  worktree({
    id: 'wt-reconnect',
    repoId: 'repo-atlas',
    displayName: 'Relay reconnect',
    branch: 'refs/heads/fix/relay-reconnect',
    comment: 'Waiting on infra to restart the staging relay',
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      number: 4052,
      title: 'Reconnect drops after host sleep',
      url: 'https://acme.atlassian.net/browse/STA-4052',
      jiraIdentifier: 'STA-4052'
    }
  }),
  worktree({
    id: 'wt-main-orca',
    repoId: 'repo-orca',
    displayName: 'main',
    branch: 'refs/heads/main',
    isMainWorktree: true
  }),
  worktree({
    id: 'wt-main-atlas',
    repoId: 'repo-atlas',
    displayName: 'main',
    branch: 'refs/heads/main',
    isMainWorktree: true
  }),
  worktree({
    id: 'wt-docs',
    repoId: 'repo-relay',
    displayName: 'Docs terminal polish',
    branch: 'refs/heads/docs/terminal-polish',
    linkedPR: 4123
  }),
  worktree({
    id: 'wt-cjk',
    repoId: 'repo-relay',
    displayName: '重构登录流程',
    branch: 'refs/heads/feature/login-rewrite'
  }),
  worktree({
    id: 'wt-accent',
    repoId: 'repo-atlas',
    displayName: 'Café déploiement',
    branch: 'refs/heads/feature/cafe-deploy'
  }),
  worktree({
    id: 'wt-linear',
    repoId: 'repo-orca',
    displayName: 'Palette ranking',
    branch: 'refs/heads/feature/palette-ranking',
    linkedLinearIssue: 'ORC-912',
    linkedWorkItem: {
      provider: 'linear',
      type: 'issue',
      number: 912,
      title: 'Rank palette results by evidence',
      url: 'https://linear.app/acme/issue/ORC-912',
      linearIdentifier: 'ORC-912'
    }
  })
]

export const CMD_J_FIXTURE_PORTS: ReadonlyMap<string, { port: number; processName?: string }[]> =
  new Map([
    ['wt-main-orca', [{ port: 3000, processName: 'node' }]],
    ['wt-docs', [{ port: 4123, processName: 'vite' }]]
  ])

export type CmdJFixtureCase = {
  query: string
  /** Worktree ids that must match, best first. An empty list means no match. */
  expected: readonly string[]
}

export const CMD_J_FIXTURE_CASES: readonly CmdJFixtureCase[] = [
  { query: 'scan daily 08-13', expected: ['wt-scan-daily'] },
  { query: 'scan daily 0813', expected: ['wt-scan-daily'] },
  { query: 'scan daily 08/13', expected: ['wt-scan-daily'] },
  { query: 'scan daily 20260813', expected: ['wt-scan-daily'] },
  { query: 'scan daily 13/08', expected: [] },
  { query: '4182', expected: ['wt-scan-daily'] },
  { query: 'nightly review run-184', expected: ['wt-scan-daily'] },
  { query: 'sta-4052 reconnect', expected: ['wt-reconnect'] },
  { query: 'reconnect infra', expected: ['wt-reconnect'] },
  { query: 'main 3000', expected: ['wt-main-orca'] },
  { query: 'acme/orca main', expected: ['wt-main-orca'] },
  { query: 'orca/main', expected: ['wt-main-orca'] },
  { query: 'docs terminal', expected: ['wt-docs'] },
  { query: '#4123', expected: ['wt-docs'] },
  { query: '123', expected: [] },
  { query: 'orc-912', expected: ['wt-linear'] },
  { query: '登录', expected: ['wt-cjk'] },
  { query: 'café', expected: ['wt-accent'] },
  { query: 'cafe', expected: ['wt-accent'] },
  { query: 'scan daily nonexistent', expected: [] },
  { query: 'daily1', expected: [] }
]

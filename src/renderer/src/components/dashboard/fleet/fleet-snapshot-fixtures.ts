import type {
  DashboardCard,
  DashboardCardSubagent,
  DashboardSnapshot
} from '../../../../../shared/agent-status/presentation/dashboard-snapshot'
import type { RepoIcon } from '../../../../../shared/repository/appearance/repo-icon'
import { FLEET_MOCK_AGENTS, type MockAgent, type MockRepo } from './fleet-mock-agent-fixtures'

export const FLEET_MOCK_NOW = Date.UTC(2026, 10, 18, 15, 0, 0)

const MINUTE = 60_000

type MockRepoInfo = { repoId: string; icon: RepoIcon | null; workspaceKind?: 'folder' }

const REPOS: Record<MockRepo, MockRepoInfo> = {
  orca: { repoId: 'repo-orca', icon: { type: 'emoji', emoji: '🐋' } },
  'orca-docs': { repoId: 'repo-orca-docs', icon: null },
  'web-app': { repoId: 'repo-web-app', icon: { type: 'lucide', name: 'Globe' } },
  notes: { repoId: 'folder-workspace:notes', icon: null, workspaceKind: 'folder' }
}

function leafIdOf(id: number): string {
  return `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`
}

function paneKeyOf(id: number): string {
  return `tab-${id}:${leafIdOf(id)}`
}

function toCard(agent: MockAgent, now: number): DashboardCard {
  const ago = (minutes: number): number => now - minutes * MINUTE
  const repo = REPOS[agent.repo]
  return {
    paneKey: paneKeyOf(agent.id),
    ptyId: `pty-${agent.id}`,
    agentType: agent.agentType,
    bucket: agent.bucket,
    dotState: agent.dotState,
    task: agent.title,
    conversationName: agent.title,
    lastAgentMessage: agent.message,
    askSummary: agent.askSummary,
    repoId: repo.repoId,
    worktreeId: `wt-${agent.worktree}`,
    tabId: `tab-${agent.id}`,
    leafId: leafIdOf(agent.id),
    parentPaneKey: agent.parent === undefined ? undefined : paneKeyOf(agent.parent),
    repoName: agent.repo,
    worktreeName: agent.worktree,
    hostKind: agent.host ? 'ssh' : 'local',
    executionHostId: agent.host?.executionHostId ?? 'local',
    hostLabel: agent.host?.hostLabel,
    workspaceKind: repo.workspaceKind ?? 'worktree',
    startedAt: ago(agent.startedMinutesAgo),
    finishedAt: agent.finishedMinutesAgo === undefined ? null : ago(agent.finishedMinutesAgo),
    stateChangedAt: ago(agent.changedMinutesAgo),
    unseen: agent.unseen ?? false,
    subagents: agent.subagents?.map(([name, dotState], index): DashboardCardSubagent => ({
      id: `${agent.id}-sub-${index}`,
      name,
      dotState
    }))
  }
}

export function buildFleetMockSnapshot(now: number): DashboardSnapshot {
  const repos = Object.entries(REPOS)
  return {
    generatedAt: now,
    cards: FLEET_MOCK_AGENTS.map((agent) => toCard(agent, now)),
    showIdle: true,
    filterOptions: {
      projects: repos.map(([name, repo]) => ({ id: repo.repoId, label: name })),
      workspaceStatuses: []
    },
    repoIconsByRepoId: Object.fromEntries(repos.map(([, repo]) => [repo.repoId, repo.icon]))
  }
}

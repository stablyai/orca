import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type {
  HostedReviewInfo,
  HostedReviewState
} from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { worktreeCardStyleSettingsUpdate } from '../../../../shared/worktree/card-style'
import * as agentExpansion from './workspace-card/activity/worktree-card-agents-expansion-state'
import { getWorktreeReviewCacheKeys } from './workspace-card/review/worktree-card-pr-derivation'

/** Store seeding for the 2.0 card fixtures: workspaces, their agents, and which results are read. */
export const MINUTE = 60_000

type AgentSeed = {
  agentType: string
  state: AgentStatusEntry['state']
  minutesAgo: number
  toolName?: string
  toolInput?: string
  message?: string
  failed?: boolean
  unread?: boolean
  prompt?: string
}

export type WorkspaceSeed = {
  id: string
  name: string
  agents: AgentSeed[]
  manualUnread?: boolean
  lastActivityMinutesAgo?: number
  /** The workspace's PR, seeded into the hosted-review cache. */
  pr?: { number: number; state: HostedReviewState }
}

export const FIXTURE_REPO: Repo = {
  id: 'repo-orca',
  path: '/repo/orca',
  displayName: 'orca',
  badgeColor: '#737373',
  addedAt: 0
}

export function makeWorktree(seed: WorkspaceSeed, now: number): Worktree {
  return {
    id: seed.id,
    repoId: 'repo-orca',
    path: `/repo/orca/${seed.name}`,
    displayName: seed.name,
    branch: `jinjing/${seed.name}`,
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: seed.manualUnread === true,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: now - (seed.lastActivityMinutesAgo ?? 30) * MINUTE
  }
}

export function seedWorkspaces(seeds: readonly WorkspaceSeed[], now: number): void {
  agentExpansion.clearWorktreeAgentExpansionStateForTests()
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
  const unreadAgentCompletionPanes: Record<string, 'agent-completion'> = {}
  const acknowledged: Record<string, number> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  for (const seed of seeds) {
    // Each agent gets a tab, plus a plain shell focused earlier, so the leading icon has layers.
    const shellTabId = `${seed.id}-shell`
    unifiedTabsByWorktree[seed.id] = [
      ...seed.agents.map((agent, index): Tab => ({
        id: `${seed.id}-tab-${index}`,
        entityId: `${seed.id}-tab-${index}`,
        groupId: `${seed.id}-group`,
        worktreeId: seed.id,
        contentType: 'terminal',
        label: agent.agentType,
        customLabel: null,
        color: null,
        sortOrder: index,
        createdAt: now - 60 * MINUTE,
        lastFocusedAt: now - agent.minutesAgo * MINUTE
      })),
      {
        id: shellTabId,
        entityId: shellTabId,
        groupId: `${seed.id}-group`,
        worktreeId: seed.id,
        contentType: 'terminal',
        label: 'zsh',
        customLabel: null,
        color: null,
        sortOrder: seed.agents.length,
        createdAt: now - 90 * MINUTE,
        lastFocusedAt: now - 90 * MINUTE
      }
    ]
    tabsByWorktree[seed.id] = seed.agents.map((agent, index) => {
      const tabId = `${seed.id}-tab-${index}`
      const paneKey = `${tabId}:00000000-0000-4000-8000-00000000000${index}`
      agentStatusByPaneKey[paneKey] = {
        state: agent.state,
        prompt: agent.prompt ?? '',
        updatedAt: now,
        stateStartedAt: now - agent.minutesAgo * MINUTE,
        agentType: agent.agentType,
        paneKey,
        tabId,
        worktreeId: seed.id,
        stateHistory: [],
        ...(agent.toolName ? { toolName: agent.toolName, toolInput: agent.toolInput } : {}),
        ...(agent.message ? { lastAssistantMessage: agent.message } : {}),
        ...(agent.failed
          ? { mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: now } }
          : {})
      }
      ptyIdsByTabId[tabId] = [`pty-${tabId}`]
      if (agent.unread) {
        unreadAgentCompletionPanes[paneKey] = 'agent-completion'
      } else {
        acknowledged[paneKey] = now - agent.minutesAgo * MINUTE
      }
      return {
        id: tabId,
        ptyId: `pty-${tabId}`,
        worktreeId: seed.id,
        title: agent.agentType,
        customTitle: null,
        color: null,
        sortOrder: index,
        createdAt: now - 60 * MINUTE
      }
    })
  }
  const settings = useAppStore.getState().settings
  const hostedReviewCache: Record<
    string,
    { data: HostedReviewInfo; fetchedAt: number; linkedReviewHintKey: string }
  > = {}
  for (const seed of seeds) {
    if (!seed.pr) {
      continue
    }
    const { hostedReviewCacheKey } = getWorktreeReviewCacheKeys(
      makeWorktree(seed, now),
      FIXTURE_REPO,
      settings
    )
    hostedReviewCache[hostedReviewCacheKey] = {
      fetchedAt: now,
      // A plain branch lookup, not a linked-PR request.
      linkedReviewHintKey: '',
      data: {
        provider: 'github',
        number: seed.pr.number,
        title: seed.name,
        state: seed.pr.state,
        url: `https://github.com/stablyai/orca/pull/${seed.pr.number}`,
        status: 'success',
        updatedAt: new Date(now).toISOString(),
        mergeable: 'MERGEABLE'
      }
    }
  }
  useAppStore.setState((state) => ({
    // Child rollups look workspaces up in the store, as the sidebar does.
    worktreesByRepo: {
      ...state.worktreesByRepo,
      [FIXTURE_REPO.id]: [
        ...(state.worktreesByRepo[FIXTURE_REPO.id] ?? []).filter(
          (row) => !seeds.some((seed) => seed.id === row.id)
        ),
        ...seeds.map((seed) => makeWorktree(seed, now))
      ]
    },
    repos: state.repos.some((repo) => repo.id === FIXTURE_REPO.id)
      ? state.repos
      : [...state.repos, FIXTURE_REPO],
    hostedReviewCache: { ...state.hostedReviewCache, ...hostedReviewCache },
    settings: state.settings
      ? {
          ...state.settings,
          ...worktreeCardStyleSettingsUpdate('experimental-2')
        }
      : state.settings,
    worktreeCardProperties: ['status', 'inline-agents'],
    tabsByWorktree: { ...state.tabsByWorktree, ...tabsByWorktree },
    unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, ...unifiedTabsByWorktree },
    ptyIdsByTabId: { ...state.ptyIdsByTabId, ...ptyIdsByTabId },
    agentStatusByPaneKey: { ...state.agentStatusByPaneKey, ...agentStatusByPaneKey },
    acknowledgedAgentsByPaneKey: { ...state.acknowledgedAgentsByPaneKey, ...acknowledged },
    agentStatusEpoch: state.agentStatusEpoch + 1,
    unreadAgentCompletionPanes: {
      ...state.unreadAgentCompletionPanes,
      ...unreadAgentCompletionPanes
    }
  }))
}

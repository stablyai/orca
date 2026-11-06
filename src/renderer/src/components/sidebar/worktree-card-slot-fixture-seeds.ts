import { useAppStore } from '@/store'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { worktreeCardStyleSettingsUpdate } from '../../../../shared/worktree/card-style'
import * as agentExpansion from './workspace-card/activity/worktree-card-agents-expansion-state'

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
  const agentStatusByPaneKey: Record<string, AgentStatusEntry> = {}
  const unreadAgentCompletionPanes: Record<string, 'agent-completion'> = {}
  const acknowledged: Record<string, number> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  for (const seed of seeds) {
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
  useAppStore.setState((state) => ({
    settings: state.settings
      ? {
          ...state.settings,
          ...worktreeCardStyleSettingsUpdate('experimental-2')
        }
      : state.settings,
    worktreeCardProperties: ['status', 'inline-agents'],
    tabsByWorktree: { ...state.tabsByWorktree, ...tabsByWorktree },
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

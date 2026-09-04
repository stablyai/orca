import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

function makeTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeWorktree(id: string, repoId = 'repo1'): Worktree & { instanceId: string } {
  return {
    id,
    instanceId: `${id}-instance`,
    repoId,
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const repoMap = new Map<string, Repo>([
  ['repo1', { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }]
])

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    browserTabsByWorktree: {},
    worktreeIdsWithLiveAgent: new Set(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    filterAgentIds: null,
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    worktreeLineageById: {},
    ...overrides
  }
}

describe('computeVisibleWorktreeIds agent filter', () => {
  it('keeps only workspaces that currently have or last used the selected agent', () => {
    const claudeCreated = { ...makeWorktree('wt-claude'), createdWithAgent: 'claude' as const }
    const teamsCreated = {
      ...makeWorktree('wt-teams'),
      createdWithAgent: 'claude-agent-teams' as const
    }
    const codexLaunch = makeWorktree('wt-codex')
    const other = makeWorktree('wt-other')

    const result = computeVisibleWorktreeIds(
      { repo1: [claudeCreated, teamsCreated, codexLaunch, other] },
      [claudeCreated.id, teamsCreated.id, codexLaunch.id, other.id],
      visibleOptions({
        filterAgentIds: ['claude'],
        tabsByWorktree: {
          [codexLaunch.id]: [makeTab('tab-codex', codexLaunch.id, 'pty-1')]
        }
      })
    )

    expect(result).toEqual([claudeCreated.id])
  })

  it('keeps workspaces that used any of the selected agents', () => {
    const claudeCreated = { ...makeWorktree('wt-claude'), createdWithAgent: 'claude' as const }
    const codexCreated = { ...makeWorktree('wt-codex'), createdWithAgent: 'codex' as const }
    const other = makeWorktree('wt-other')

    const result = computeVisibleWorktreeIds(
      { repo1: [claudeCreated, codexCreated, other] },
      [claudeCreated.id, codexCreated.id, other.id],
      visibleOptions({
        filterAgentIds: ['claude', 'codex']
      })
    )

    expect(result).toEqual([claudeCreated.id, codexCreated.id])
  })

  it('matches Codex via launchAgent and live agent-type records', () => {
    const launched = makeWorktree('wt-launch')
    const live = makeWorktree('wt-live')
    const other = makeWorktree('wt-other')
    const launchTab = {
      ...makeTab('tab-launch', launched.id, 'pty-1'),
      launchAgent: 'codex' as const
    }

    const result = computeVisibleWorktreeIds(
      { repo1: [launched, live, other] },
      [launched.id, live.id, other.id],
      visibleOptions({
        filterAgentIds: ['codex'],
        tabsByWorktree: { [launched.id]: [launchTab] },
        agentTypesByWorktree: { [live.id]: ['codex'] }
      })
    )

    expect(result).toEqual([launched.id, live.id])
  })

  it('shows every workspace when the agent filter is cleared', () => {
    const claudeCreated = { ...makeWorktree('wt-claude'), createdWithAgent: 'claude' as const }
    const other = makeWorktree('wt-other')

    const result = computeVisibleWorktreeIds(
      { repo1: [claudeCreated, other] },
      [claudeCreated.id, other.id],
      visibleOptions({
        filterAgentIds: null
      })
    )

    expect(result).toEqual([claudeCreated.id, other.id])
  })
})

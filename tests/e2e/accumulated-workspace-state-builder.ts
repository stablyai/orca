import path from 'node:path'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'
import type { Repo } from '../../src/shared/repo-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../src/shared/terminal-tab-types'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../src/shared/tab-types'
import type { WorktreeLineage } from '../../src/shared/worktree/lineage-types'
import type { Worktree } from '../../src/shared/worktree/types'
import type { NormalizedAccumulatedWorkspaceFixtureOptions } from './accumulated-workspace-profile'

export type SyntheticLiveStatus = {
  paneKey: string
  tabId: string
  worktreeId: string
  prompt: string
}

export type AccumulatedWorkspaceSeed = {
  repos: Repo[]
  worktreesByRepo: Record<string, Worktree[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
  worktreeLineageById: Record<string, WorktreeLineage>
  liveStatuses: SyntheticLiveStatus[]
}

function bucketSize(total: number, buckets: number, index: number): number {
  return Math.floor(total / buckets) + (index < total % buckets ? 1 : 0)
}

function paneId(ordinal: number): string {
  return `00000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`
}

function layoutRoot(panes: readonly string[]): TerminalPaneLayoutNode {
  return panes.slice(1).reduce<TerminalPaneLayoutNode>(
    (second, leafId) => ({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId },
      second
    }),
    { type: 'leaf', leafId: panes[0] }
  )
}

export function buildAccumulatedWorkspaceSeed(
  config: NormalizedAccumulatedWorkspaceFixtureOptions,
  now = Date.now()
): AccumulatedWorkspaceSeed {
  const syntheticRoot = path.join(path.parse(process.cwd()).root, 'orca-typing-benchmark')
  const repos: Repo[] = Array.from({ length: config.repositories }, (_, index) => ({
    id: `synthetic-repo-${index}`,
    path: path.join(syntheticRoot, `repo-${index}`),
    displayName: `Synthetic repo ${index}`,
    badgeColor: '#737373',
    addedAt: now - index,
    kind: 'git'
  }))
  const worktreesByRepo: Record<string, Worktree[]> = Object.fromEntries(
    repos.map((repo) => [repo.id, []])
  )
  const rows: Worktree[] = []
  const parentIdByWorktreeId = new Map<string, string>()
  for (let index = 0; index < config.worktrees; index += 1) {
    const repoIndex = index % config.repositories
    const repo = repos[repoIndex]
    const repoOrdinal = Math.floor(index / config.repositories)
    const id = `synthetic-worktree-${index}`
    // Ordinals 1, 1 + lineageEvery, ...; `% lineageEvery === 1` skipped everything at an interval of 1.
    if (repoOrdinal >= 1 && (repoOrdinal - 1) % config.lineageEvery === 0) {
      parentIdByWorktreeId.set(id, `synthetic-worktree-${index - config.repositories}`)
    }
    const row: Worktree = {
      id,
      instanceId: `synthetic-instance-${index}`,
      repoId: repo.id,
      path: path.join(repo.path, `worktree-${repoOrdinal}`),
      displayName: `Synthetic workspace ${index}`,
      comment: `Accumulated benchmark workspace ${index}`,
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: index % 5 === 0,
      isPinned: index % 11 === 0,
      sortOrder: repoOrdinal,
      lastActivityAt: now - index * 1_000,
      head: '0000000000000000000000000000000000000000',
      branch: `synthetic-${index}`,
      isBare: false,
      isMainWorktree: repoOrdinal === 0
    }
    rows.push(row)
    worktreesByRepo[repo.id].push(row)
  }

  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const ptyIdsByTabId: Record<string, string[]> = {}
  const terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot> = {}
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}
  const sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord> = {}
  const worktreeLineageById: Record<string, WorktreeLineage> = {}
  const liveStatuses: SyntheticLiveStatus[] = []
  let terminalOrdinal = 0
  let extraUnifiedOrdinal = 0
  let paneOrdinal = 0

  for (const [worktreeIndex, row] of rows.entries()) {
    const groupId = `synthetic-group-${worktreeIndex}`
    const terminalCount = bucketSize(config.terminalTabs, config.worktrees, worktreeIndex)
    const extraUnifiedCount = bucketSize(
      config.unifiedTabs - config.terminalTabs,
      config.worktrees,
      worktreeIndex
    )
    const terminalTabs: TerminalTab[] = []
    const unifiedTabs: Tab[] = []
    for (let tabIndex = 0; tabIndex < terminalCount; tabIndex += 1) {
      const tabId = `synthetic-tab-${terminalOrdinal}`
      const panes = Array.from({ length: config.panesPerTab }, () => paneId(++paneOrdinal))
      terminalTabs.push({
        id: tabId,
        ptyId: null,
        worktreeId: row.id,
        title: `Terminal ${tabIndex + 1}`,
        defaultTitle: `Terminal ${tabIndex + 1}`,
        customTitle: null,
        color: null,
        sortOrder: tabIndex,
        createdAt: now - terminalOrdinal
      })
      unifiedTabs.push({
        id: tabId,
        entityId: tabId,
        groupId,
        worktreeId: row.id,
        contentType: 'terminal',
        label: `Terminal ${tabIndex + 1}`,
        customLabel: null,
        color: null,
        sortOrder: tabIndex,
        createdAt: now - terminalOrdinal
      })
      ptyIdsByTabId[tabId] = []
      terminalLayoutsByTabId[tabId] = {
        root: layoutRoot(panes),
        activeLeafId: panes[0],
        expandedLeafId: null,
        titlesByLeafId: Object.fromEntries(
          panes.map((leafId, index) => [leafId, `Pane ${index + 1}`])
        )
      }
      for (const [tabPaneIndex, leafId] of panes.entries()) {
        const paneKey = `${tabId}:${leafId}`
        const zeroBasedPaneOrdinal = paneOrdinal - panes.length + tabPaneIndex
        if (zeroBasedPaneOrdinal < config.liveStatuses) {
          liveStatuses.push({
            paneKey,
            tabId,
            worktreeId: row.id,
            prompt: `Synthetic live task ${worktreeIndex}`
          })
        } else if (zeroBasedPaneOrdinal < config.liveStatuses + config.sleepingRecords) {
          sleepingAgentSessionsByPaneKey[paneKey] = {
            paneKey,
            tabId,
            worktreeId: row.id,
            agent: 'codex',
            providerSession: {
              key: 'session_id',
              id: `synthetic-session-${zeroBasedPaneOrdinal + 1}`
            },
            prompt: `Synthetic parked task ${worktreeIndex}`,
            state: 'working',
            capturedAt: now,
            updatedAt: now,
            terminalTitle: `Parked ${worktreeIndex}`,
            origin: 'worktree-sleep',
            restoreOnTabOpenOnly: true
          }
        }
      }
      terminalOrdinal += 1
    }
    for (let tabIndex = 0; tabIndex < extraUnifiedCount; tabIndex += 1) {
      const entityId = path.join(row.path, `synthetic-file-${extraUnifiedOrdinal}.ts`)
      unifiedTabs.push({
        id: entityId,
        entityId,
        groupId,
        worktreeId: row.id,
        contentType: 'editor',
        label: `synthetic-file-${extraUnifiedOrdinal}.ts`,
        customLabel: null,
        color: null,
        sortOrder: terminalCount + tabIndex,
        createdAt: now - config.terminalTabs - extraUnifiedOrdinal
      })
      extraUnifiedOrdinal += 1
    }
    const tabOrder = unifiedTabs.map(({ id }) => id)
    tabsByWorktree[row.id] = terminalTabs
    unifiedTabsByWorktree[row.id] = unifiedTabs
    groupsByWorktree[row.id] = [
      { id: groupId, worktreeId: row.id, activeTabId: tabOrder[0] ?? null, tabOrder }
    ]
    activeGroupIdByWorktree[row.id] = groupId
    layoutByWorktree[row.id] = { type: 'leaf', groupId }
  }

  for (const [rowIndex, row] of rows.entries()) {
    const parentWorktreeId = parentIdByWorktreeId.get(row.id)
    if (!parentWorktreeId) {
      continue
    }
    worktreeLineageById[row.id] = {
      worktreeId: row.id,
      worktreeInstanceId: `synthetic-instance-${rowIndex}`,
      parentWorktreeId,
      parentWorktreeInstanceId: `synthetic-instance-${parentWorktreeId.split('-').at(-1)}`,
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: now - rowIndex * 1_000
    }
  }

  return {
    repos,
    worktreesByRepo,
    tabsByWorktree,
    ptyIdsByTabId,
    terminalLayoutsByTabId,
    unifiedTabsByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree,
    layoutByWorktree,
    sleepingAgentSessionsByPaneKey,
    worktreeLineageById,
    liveStatuses
  }
}

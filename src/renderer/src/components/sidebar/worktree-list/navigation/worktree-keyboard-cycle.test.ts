import { describe, expect, it } from 'vitest'
import type { BotGroup } from '../../../../../../shared/bots/bot-group'
import type { BotSidebarEntry } from '../../../../../../shared/bots/bot-sidebar-entries'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import {
  getLineageGroupKey,
  getWorktreeLineageGroupKey
} from '../../../../../../shared/sidebar-list/sections/group-keys'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  buildBotSidebarCycleRows,
  collectVisibleBotWorkerWorktrees
} from '@/components/bots/bot-sidebar-cycle-entries'
import { resolveCycledWorkspaceRow } from './worktree-keyboard-cycle'

type TestBot = { hostId: ExecutionHostId }

function makeWorktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: 'repo-1',
    path: `/tmp/${id}`,
    head: 'abc',
    branch: `refs/heads/${id}`,
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
    lastActivityAt: 0,
    ...overrides
  }
}

function makeFolder(id: string, overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id,
    projectGroupId: 'bots-group',
    name: id,
    folderPath: `/tmp/${id}`,
    comment: '',
    linkedTask: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeGroup(id: string, folderWorkspaceId: string): BotGroup {
  return {
    id,
    name: id,
    folder: id,
    folderWorkspaceId,
    members: [],
    formerSessionIds: [],
    replyMode: { kind: 'mentions' },
    revision: 1,
    createdAt: 1,
    hostId: 'local'
  }
}

function makeRepo(id: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName: id,
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

function makeProjectRow(worktree: Worktree, repo?: Repo): HostSectionRow {
  return {
    type: 'item',
    worktree,
    repo,
    rowKey: `row:${worktree.hostId ?? 'local'}:${worktree.id}`,
    sectionKey: 'repo:repo-1',
    depth: 0,
    groupDepth: 0,
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

describe('worktree keyboard cycling across Bots and Projects', () => {
  const localRepo = makeRepo('repo-1')
  const sshRepo = makeRepo('repo-ssh', { executionHostId: 'ssh:box' })
  const repoMap = new Map<string, Repo>([
    [localRepo.id, localRepo],
    [sshRepo.id, sshRepo]
  ])

  const botHome = makeFolder('bot-home-1')
  const groupHome = makeFolder('group-home-1')
  const botWorker = makeWorktree('wt-bot-worker')
  const botWorkerChild = makeWorktree('wt-bot-worker-child')
  const projectWt = makeWorktree('wt-proj-1')
  const pairedHost: ExecutionHostId = 'runtime:paired-1'
  const remoteBotHome = makeFolder('remote-bot-home', { executionHostId: pairedHost })

  const botEntry: BotSidebarEntry<TestBot, BotGroup, FolderWorkspace> = {
    kind: 'bot',
    id: 'local/bot-1',
    bot: { hostId: 'local' },
    home: botHome
  }
  const groupEntry: BotSidebarEntry<TestBot, BotGroup, FolderWorkspace> = {
    kind: 'group',
    id: 'local/group-1',
    group: makeGroup('group-1', groupHome.id),
    home: groupHome
  }
  const remoteBotEntry: BotSidebarEntry<TestBot, BotGroup, FolderWorkspace> = {
    kind: 'bot',
    id: `${pairedHost}/bot-remote`,
    bot: { hostId: pairedHost },
    home: remoteBotHome
  }

  const projectRows: HostSectionRow[] = [makeProjectRow(projectWt, localRepo)]

  it('round-trips Bots -> Projects -> Bots across Bot Home, worker, Group Home, and Projects', () => {
    const collapsed = new Set<string>()
    const visibleWorkers = collectVisibleBotWorkerWorktrees(
      [botWorker],
      new Map([[getWorktreeHostIdentity(botWorker), [botWorkerChild]]]),
      collapsed
    )
    const botsRows = buildBotSidebarCycleRows({
      entries: [botEntry, groupEntry],
      workersByEntryKey: new Map([[botEntry.id, visibleWorkers]]),
      collapsedGroups: collapsed,
      repoMap,
      isHostOffline: () => false
    })

    const step = (
      activeWorktreeId: string,
      activeHost: ExecutionHostId,
      direction: 'up' | 'down',
      projectsFirst = false
    ) =>
      resolveCycledWorkspaceRow({
        rows: projectRows,
        pinnedDisplayPolicy: 'single-location',
        botsRows,
        projectsFirst,
        projectsCollapsed: false,
        activeWorktreeId,
        activeWorkspaceExecutionHostId: activeHost,
        lastActiveWorkspace: null,
        navHistory: [],
        navHistoryIndex: -1,
        direction
      })

    // Bots above Projects: botHome -> botWorker -> botWorkerChild -> groupHome -> projectWt -> botHome
    const first = step(folderWorkspaceKey(botHome.id), 'local', 'down')
    expect(first?.worktree.id).toBe(botWorker.id)
    const second = step(first!.worktree.id, 'local', 'down')
    expect(second?.worktree.id).toBe(botWorkerChild.id)
    const third = step(second!.worktree.id, 'local', 'down')
    expect(third?.worktree.id).toBe(folderWorkspaceKey(groupHome.id))
    expect(third?.botGroup?.id).toBe('group-1')
    const fourth = step(third!.worktree.id, 'local', 'down')
    expect(fourth?.worktree.id).toBe(projectWt.id)
    // Wrapping forward from Projects returns to Bot Home.
    const wrappedForward = step(fourth!.worktree.id, 'local', 'down')
    expect(wrappedForward?.worktree.id).toBe(folderWorkspaceKey(botHome.id))
    // Reversing from Projects returns to Group Home.
    const reversedBack = step(fourth!.worktree.id, 'local', 'up')
    expect(reversedBack?.worktree.id).toBe(folderWorkspaceKey(groupHome.id))

    // Projects above Bots: projectWt -> botHome -> ... -> groupHome -> projectWt
    const fromProjectsFirst = step(projectWt.id, 'local', 'down', true)
    expect(fromProjectsFirst?.worktree.id).toBe(folderWorkspaceKey(botHome.id))
    const upFromProjectsFirst = step(projectWt.id, 'local', 'up', true)
    expect(upFromProjectsFirst?.worktree.id).toBe(folderWorkspaceKey(groupHome.id))
  })

  it('deduplicates a worktree shown in both Bots and Projects without collapsing distinct hosts', () => {
    const sshTwin = makeWorktree(botWorker.id, { repoId: sshRepo.id, hostId: 'ssh:box' })
    const botsRows = buildBotSidebarCycleRows({
      entries: [botEntry, remoteBotEntry],
      workersByEntryKey: new Map([[botEntry.id, [botWorker]]]),
      collapsedGroups: new Set(),
      repoMap,
      isHostOffline: () => false
    })
    const rowsWithDuplicateAndTwin: HostSectionRow[] = [
      makeProjectRow(botWorker, localRepo),
      makeProjectRow(sshTwin, sshRepo),
      makeProjectRow(projectWt, localRepo)
    ]

    // From local botWorker, down advances to remoteBotHome, then sshTwin (not a second local botWorker).
    const nextFromWorker = resolveCycledWorkspaceRow({
      rows: rowsWithDuplicateAndTwin,
      pinnedDisplayPolicy: 'single-location',
      botsRows,
      projectsFirst: false,
      projectsCollapsed: false,
      activeWorktreeId: botWorker.id,
      activeWorkspaceExecutionHostId: 'local',
      lastActiveWorkspace: null,
      navHistory: [],
      navHistoryIndex: -1,
      direction: 'down'
    })
    expect(nextFromWorker?.worktree.id).toBe(folderWorkspaceKey(remoteBotHome.id))
    expect(nextFromWorker?.worktree.hostId).toBe(pairedHost)

    const nextFromRemoteBot = resolveCycledWorkspaceRow({
      rows: rowsWithDuplicateAndTwin,
      pinnedDisplayPolicy: 'single-location',
      botsRows,
      projectsFirst: false,
      projectsCollapsed: false,
      activeWorktreeId: folderWorkspaceKey(remoteBotHome.id),
      activeWorkspaceExecutionHostId: pairedHost,
      lastActiveWorkspace: null,
      navHistory: [],
      navHistoryIndex: -1,
      direction: 'down'
    })
    expect(nextFromRemoteBot?.worktree.id).toBe(sshTwin.id)
    expect(nextFromRemoteBot?.worktree.hostId).toBe('ssh:box')
  })

  it('skips folded bot workers, folded lineage children, offline hosts, and collapsed Projects', () => {
    const collapsed = new Set<string>([
      getLineageGroupKey(folderWorkspaceKey(botHome.id)),
      getWorktreeLineageGroupKey(botWorker)
    ])
    expect(
      collectVisibleBotWorkerWorktrees(
        [botWorker],
        new Map([[getWorktreeHostIdentity(botWorker), [botWorkerChild]]]),
        collapsed
      ).map((w) => w.id)
    ).toEqual([botWorker.id])

    const botsRows = buildBotSidebarCycleRows({
      entries: [botEntry, groupEntry],
      workersByEntryKey: new Map([[botEntry.id, [botWorker]]]),
      collapsedGroups: collapsed,
      repoMap,
      isHostOffline: () => false
    })
    expect(botsRows.map((row) => row.worktree.id)).toEqual([
      folderWorkspaceKey(botHome.id),
      folderWorkspaceKey(groupHome.id)
    ])

    // Collapsed Projects section excludes Projects rows from global cycling.
    const nextWithProjectsCollapsed = resolveCycledWorkspaceRow({
      rows: projectRows,
      pinnedDisplayPolicy: 'single-location',
      botsRows,
      projectsFirst: false,
      projectsCollapsed: true,
      activeWorktreeId: folderWorkspaceKey(groupHome.id),
      activeWorkspaceExecutionHostId: 'local',
      lastActiveWorkspace: null,
      navHistory: [],
      navHistoryIndex: -1,
      direction: 'down'
    })
    expect(nextWithProjectsCollapsed?.worktree.id).toBe(folderWorkspaceKey(botHome.id))

    // Offline bot host lists only the bot row, never its workers.
    const offlineRows = buildBotSidebarCycleRows({
      entries: [remoteBotEntry],
      workersByEntryKey: new Map([[remoteBotEntry.id, [botWorker]]]),
      collapsedGroups: new Set(),
      repoMap,
      isHostOffline: (hostId) => hostId === pairedHost
    })
    expect(offlineRows.map((row) => row.worktree.id)).toEqual([
      folderWorkspaceKey(remoteBotHome.id)
    ])
  })

  it('keeps Projects-only cycling untouched when botsRows is omitted', () => {
    const secondProjectWt = makeWorktree('wt-proj-2')
    const rows = [makeProjectRow(projectWt, localRepo), makeProjectRow(secondProjectWt, localRepo)]
    const next = resolveCycledWorkspaceRow({
      rows,
      pinnedDisplayPolicy: 'single-location',
      activeWorktreeId: secondProjectWt.id,
      activeWorkspaceExecutionHostId: 'local',
      lastActiveWorkspace: null,
      navHistory: [],
      navHistoryIndex: -1,
      direction: 'down'
    })
    expect(next?.worktree.id).toBe(projectWt.id)
  })
})

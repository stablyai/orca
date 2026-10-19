import type { AppState } from '@/store/types'
import { getAllWorktreesFromState } from '@/store/selectors'
import { getProjectHostSetupProjectionFromState } from '@/store/project-host-setup-selector'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  getLocalExecutionHostLabel,
  getRepoExecutionHostId,
  getSettingsFocusedExecutionHostId
} from '../../../../shared/execution-host'
import { withRepoHostOwnership } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getPinnedWorktreeDisplayPolicy } from '../../../../shared/sidebar-list/row-types'
import type { HostSectionRow } from '../../../../shared/sidebar-list/host-section-rows'
import { buildWorkspaceRows } from '../../../../shared/sidebar-list/workspace-rows'
import {
  buildPairedServerReviewFacts,
  buildWorkspaceReviewFacts
} from '../../../../shared/sidebar-list/workspace-review-facts'
import type {
  SidebarFeedCatalog,
  SidebarFeedView
} from '../../../../shared/sidebar-list/sidebar-feed-rows'
import type { SmartStampFields } from '../../../../shared/sidebar-list/sort-stamps'
import { buildPairedServerActivityFacts } from '../../../../shared/sidebar-list/paired-server-activity-facts'
import { GOLDEN_NOW, folder, group, lineage } from './sidebar-list-golden-factories.test-fixture'
import { sidebarWorkspaceRowFilters } from './sidebar-filter-actions'
import {
  readWindowWorkspaceActivityFacts,
  toLocallyOwnedRows
} from '@/lib/sidebar-shadow/workspace-activity-shadow'
import { readWindowDesktopSidebarFacts } from '@/lib/sidebar-shadow/desktop-facts-shadow'
import {
  readWindowPairedServerHosts,
  readWindowPairedServerRows
} from '@/lib/sidebar-shadow/paired-server-rows-shadow'
import type { SidebarInputsFeedDomain } from '../../../../main/runtime/sidebar-inputs/sidebar-inputs-feed'

const SERVER_HOST_ID = 'runtime:env-1'

const buildServer: PublicKnownRuntimeEnvironment = {
  id: 'env-1',
  name: 'Build server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://127.0.0.1:1' }],
  preferredEndpointId: 'ws'
}

// Stamps on every host's rows, so Recent and Smart order across local, SSH and the paired server.
const STAMPS: Record<string, SmartStampFields & { lastActivityAt?: number; isUnread?: boolean }> = {
  Zeta: { smartTier: 'needs-you', smartAt: GOLDEN_NOW - 600_000 },
  // Done holds only while unread: feat-a and api-y were not read yet.
  'feat-a': { smartTier: 'done', smartAt: GOLDEN_NOW - 60_000, isUnread: true },
  'api-y': {
    smartTier: 'done',
    smartAt: GOLDEN_NOW - 59_000,
    lastActivityAt: GOLDEN_NOW - 2_000,
    isUnread: true
  },
  'remote-x': { smartTier: 'working', smartAt: GOLDEN_NOW - 30_000 },
  // Read since it finished, so it ranks as Rest.
  'feat-b': { smartTier: 'done', smartAt: GOLDEN_NOW - 1_000 },
  'gitlab-mr': { smartTier: 'working', smartAt: GOLDEN_NOW - 900_000 }
}

/**
 * What the parity suite adds to the golden store: stamps, a paired server the desktop knows with
 * a nested workspace and a folder workspace, an SSH connection, a saved host order and a creation
 * this host runs.
 */
export function parityWorldOverrides(base: Partial<AppState>): Partial<AppState> {
  const repoById = new Map((base.repos ?? []).map((repo) => [repo.id, repo]))
  const worktreesByRepo: AppState['worktreesByRepo'] = {}
  for (const [repoId, worktrees] of Object.entries(base.worktreesByRepo ?? {})) {
    const repo = repoById.get(repoId)
    worktreesByRepo[repoId] = worktrees.map((worktree) => {
      const branch = worktree.branch.replace('refs/heads/', '')
      const stamps = {
        ...STAMPS[branch],
        ...(branch === 'Zeta'
          ? { cliProvenance: { kind: 'created-by-cli' as const, createdAt: 1 } }
          : {})
      }
      // Hosts stamped as the window's catalog fetch stamps them.
      const listed = repo ? withRepoHostOwnership(worktree, getRepoExecutionHostId(repo)) : worktree
      return { ...listed, ...stamps }
    })
  }
  const pending = Object.values(base.pendingWorktreeCreations ?? {})[0]
  const [serverMain, serverChild] = worktreesByRepo.api ?? []
  return {
    worktreesByRepo,
    // A server workspace nested under the server's main, and a server folder workspace.
    worktreeLineageById: {
      ...base.worktreeLineageById,
      ...(serverMain && serverChild ? { [serverChild.id]: lineage(serverChild, serverMain) } : {})
    },
    projectGroups: [
      ...(base.projectGroups ?? []),
      group('pg-server-folders', 'Server folders', {
        parentPath: '/srv/folders',
        createdFrom: 'folder-scan',
        executionHostId: SERVER_HOST_ID,
        tabOrder: 3
      })
    ],
    folderWorkspaces: [
      ...(base.folderWorkspaces ?? []),
      folder('fw-server', 'pg-server-folders', { executionHostId: SERVER_HOST_ID, sortOrder: 3 })
    ],
    runtimeEnvironments: [buildServer],
    sshConnectionStates: new Map([
      ['gpu-vm', { targetId: 'gpu-vm', status: 'connected', error: null, reconnectAttempt: 0 }]
    ]),
    // A creation main runs: one on a paired server is that server's own (see exclusions).
    pendingWorktreeCreations: pending
      ? { [pending.creationId]: { ...pending, request: { ...pending.request, repoId: 'orca' } } }
      : {},
    workspaceHostOrder: ['ssh:gpu-vm', SERVER_HOST_ID, 'local'],
    // Desktop-only cards (imported, new external) are no feed input, so neither side gets them.
    detectedWorktreesByRepo: {}
  }
}

/** The occurrence the parity suite opens; a pinned duplicate highlights in both places. */
export function parityActiveState(
  worktreeId: string,
  hostId: AppState['activeWorkspaceExecutionHostId']
): Partial<AppState> {
  return { activeWorktreeId: worktreeId, activeWorkspaceExecutionHostId: hostId }
}

const SERVER_WORKTREE_ID = 'api::/w/api-y'

/** A desktop terminal in a server workspace: the PTY is the server's, which reports it. */
export function parityServerTerminalState(): Partial<AppState> {
  return {
    tabsByWorktree: {
      [SERVER_WORKTREE_ID]: [
        {
          id: 'tab-server',
          ptyId: 'pty-server',
          worktreeId: SERVER_WORKTREE_ID,
          title: 'Terminal 1',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: GOLDEN_NOW
        }
      ]
    },
    ptyIdsByTabId: { 'tab-server': ['pty-server'] }
  }
}

/** A desktop browser tab in a server workspace: the server never sees it. */
export function parityServerBrowserTabState(): Partial<AppState> {
  return {
    browserTabsByWorktree: {
      [SERVER_WORKTREE_ID]: [
        {
          id: 'browser-server',
          worktreeId: SERVER_WORKTREE_ID,
          url: 'about:blank',
          title: '',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: GOLDEN_NOW
        }
      ]
    }
  }
}

/**
 * The feed domains main would publish for this store, read through the window-side projections
 * the shadow comparison held equal to main's producers before the window read main's feed.
 */
export function feedDomainsFromWindowState(state: AppState): SidebarInputsFeedDomain[] {
  const worktrees = getAllWorktreesFromState(state)
  const servers = readWindowPairedServerHosts(state, new Set([SERVER_HOST_ID]))
  const windowActivity = readWindowWorkspaceActivityFacts(state, GOLDEN_NOW)
  const serverRows = readWindowPairedServerRows(state, new Set(servers.keys()))
  // The server reports the terminals and agents the desktop runs in its workspaces.
  const reportedRows = [...serverRows.values()].map((row) => {
    const facts = windowActivity.get(row.worktreeId)
    return { ...row, activity: { terminal: facts?.terminal ?? null, agent: facts?.agent ?? null } }
  })
  const domain = (name: string, read: () => Record<string, unknown>): SidebarInputsFeedDomain => ({
    name,
    read,
    watch: () => () => {}
  })
  return [
    domain('workspaces', () =>
      Object.fromEntries(
        buildWorkspaceRows({
          worktrees,
          folderWorkspaces: state.folderWorkspaces,
          repos: state.repos,
          lineageById: state.worktreeLineageById
        })
      )
    ),
    domain('activity', () => ({
      // The window's browser and chat tabs, as its saved session for the server holds them.
      ...buildPairedServerActivityFacts(
        [{ hostId: SERVER_HOST_ID, freshness: 'live', rows: reportedRows }],
        () => ({
          browserTabsByWorktree: state.browserTabsByWorktree,
          unifiedTabs: state.unifiedTabsByWorktree
        })
      ),
      ...Object.fromEntries(toLocallyOwnedRows(state, windowActivity))
    })),
    domain('review', () => ({
      ...buildPairedServerReviewFacts(
        [{ hostId: SERVER_HOST_ID, rows: [...serverRows.values()] }],
        state.prCache
      ),
      ...Object.fromEntries(
        toLocallyOwnedRows(
          state,
          new Map(Object.entries(buildWorkspaceReviewFacts(worktrees, state.repos, state.prCache)))
        )
      )
    })),
    domain('creations', () =>
      Object.fromEntries(
        Object.values(state.pendingWorktreeCreations ?? {}).map((creation) => [
          creation.creationId,
          { repoId: creation.request.repoId }
        ])
      )
    ),
    domain('temporal', () => ({ sessionId: 'session-1', retention: null })),
    domain('pairedServerHosts', () =>
      Object.fromEntries(
        [...servers].map(([hostId, host]) => [hostId, { freshness: 'live', host }])
      )
    ),
    domain('pairedServerRows', () => Object.fromEntries(serverRows)),
    domain('desktop', () => readWindowDesktopSidebarFacts(state))
  ]
}

/** What the host's own phone reads beside the feed: repo.list, groups and ui.get/settings.get. */
export function phoneInputsFromWindowState(state: AppState): {
  catalog: SidebarFeedCatalog
  view: SidebarFeedView
} {
  const projection = getProjectHostSetupProjectionFromState(state)
  return {
    catalog: {
      repos: state.repos,
      projectGroups: state.projectGroups ?? [],
      // The projection the window publishes for the phone (mobileRelay.projectSections).
      projectGrouping: {
        projects: projection.projects,
        projectHostSetups: projection.setups
      }
    },
    view: {
      groupBy: state.groupBy,
      sortBy: state.sortBy,
      projectOrderBy: state.projectOrderBy,
      collapsedGroups: state.collapsedGroups,
      filters: sidebarWorkspaceRowFilters(state),
      workspaceHostScope: state.workspaceHostScope,
      visibleWorkspaceHostIds: state.visibleWorkspaceHostIds,
      workspaceStatuses: state.workspaceStatuses,
      pinnedDisplayPolicy: getPinnedWorktreeDisplayPolicy(state.settings),
      defaultHostId: getSettingsFocusedExecutionHostId(state.settings),
      hostLabelOverrides: getHostDisplayLabelOverrides(state.settings),
      localHostLabel: getLocalExecutionHostLabel()
    }
  }
}

/**
 * What both adapters must agree on, one line per row in occurrence order: headers with their
 * counts and collapse keys, lineage keys, and which occurrences are active. Labels a client draws
 * from its own icons, host health and card contents are presentation and left out.
 */
export function projectParityRows(
  rows: readonly HostSectionRow[],
  activeRowKeys: ReadonlySet<string>
): string[] {
  return rows.flatMap((row): string[] => {
    switch (row.type) {
      case 'host-header':
        return [
          `HOST ${row.key} host=${row.hostId} label=${row.label} count=${row.count}${row.collapsed ? ' collapsed' : ''}`
        ]
      case 'header':
        return [
          `HEADER ${row.key} collapseKey=${row.collapseKey ?? '-'} label=${row.label ?? '-'} icon=${JSON.stringify(row.icon)} count=${row.count} hostId=${row.hostId ?? '-'}`
        ]
      case 'item':
        return [
          `ITEM ${row.rowKey} section=${row.sectionKey} depth=${row.depth}/${row.groupDepth} lineageKey=${row.lineageGroupKey ?? '-'}${row.lineageCollapsed ? ' lineageCollapsed' : ''} children=${row.lineageChildCount}${activeRowKeys.has(row.rowKey) ? ' ACTIVE' : ''}`
        ]
      case 'folder-workspace':
        return [
          `FOLDER ${row.key} group=${row.projectGroup.id} depth=${row.depth}/${row.groupDepth}${activeRowKeys.has(row.key) ? ' ACTIVE' : ''}`
        ]
      case 'pending-creation':
        return [`PENDING ${row.key}`]
      // Desktop-only cards: the feed never carries detected worktrees (see exclusions).
      case 'imported-worktrees-card':
      case 'new-external-worktrees-inbox':
        return []
    }
  })
}

import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import { NO_WORKSPACE_ROW_FILTERS } from '../workspace-view/workspace-row-filters'
import type { Worktree } from '../worktree/types'
import { ALL_GROUP_KEY } from './group-keys'
import type { HostSectionRow } from './host-section-rows'
import { normalizePairedServerRow } from './paired-server-rows'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import {
  indexSidebarFeed,
  rankSidebarFeedWorktrees,
  withHeldProjectRecency,
  type SidebarFeedIndex
} from './sidebar-feed-index'
import {
  buildSidebarFeedRows,
  planSidebarFeedRows,
  renderSidebarFeedRows,
  type SidebarFeedCatalog,
  type SidebarFeedView
} from './sidebar-feed-rows'
import { IDLE_WORKSPACE_ACTIVITY } from './workspace-activity-facts'
import { buildWorkspaceRows } from './workspace-rows'

function worktree(id: string, overrides: Partial<Worktree> = {}): Worktree {
  return {
    id,
    repoId: id.split('::')[0],
    path: id.split('::')[1],
    head: 'abc',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id.split('/').at(-1) ?? id,
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

function repo(id: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '', addedAt: 0, ...overrides }
}

function domains(overrides: Partial<SidebarFeedDomains>): SidebarFeedDomains {
  return {
    workspaces: new Map(),
    activity: new Map(),
    review: new Map(),
    creations: new Map(),
    pairedServerHosts: new Map(),
    pairedServerRows: new Map(),
    repoIcons: new Map(),
    desktop: null,
    projectCatalog: null,
    retention: null,
    ...overrides
  }
}

function view(overrides: Partial<SidebarFeedView> = {}): SidebarFeedView {
  return {
    groupBy: 'none',
    sortBy: 'recent',
    projectOrderBy: 'manual',
    collapsedGroups: new Set(),
    filters: NO_WORKSPACE_ROW_FILTERS,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: null,
    workspaceStatuses: [],
    pinnedDisplayPolicy: 'single-location',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    hostLabelOverrides: new Map(),
    localHostLabel: 'This computer',
    ...overrides
  }
}

function catalog(repos: Repo[], projectGroups: ProjectGroup[] = []): SidebarFeedCatalog {
  return { repos, projectGroups, projectGrouping: { projects: [], projectHostSetups: [] } }
}

/** Each listed row as `host|id@depth`, headers as `# label@depth`. */
function outline(rows: readonly HostSectionRow[]): string[] {
  return rows.flatMap((row) => {
    if (row.type === 'item') {
      return [`${row.worktree.hostId ?? ''}|${row.worktree.id}@${String(row.depth)}`]
    }
    if (row.type === 'header' && row.key !== ALL_GROUP_KEY) {
      return [`# ${row.label ?? row.key}@${String(row.projectGroupDepth ?? 0)}`]
    }
    return row.type === 'host-header' ? [`## ${row.label}`] : []
  })
}

describe('buildSidebarFeedRows keeps same-id workspaces on two hosts apart', () => {
  // The same repo registered locally and on an SSH box: `r::/w/same` names two workspaces.
  const repos = [repo('r'), repo('r', { connectionId: 'box' })]
  const workspaces = buildWorkspaceRows({
    worktrees: [
      // A twin repo's local rows name their host, as the window stamps them.
      worktree('r::/w/same', { hostId: 'local', displayName: 'Z', lastActivityAt: 100 }),
      worktree('r::/w/other', { hostId: 'local', displayName: 'M', lastActivityAt: 200 }),
      worktree('r::/w/same', { hostId: 'ssh:box', displayName: 'A', lastActivityAt: 300 })
    ],
    folderWorkspaces: [],
    repos,
    lineageById: {}
  })

  it.each(['recent', 'name'] as const)('orders each twin by its own %s stamp', (sortBy) => {
    const built = buildSidebarFeedRows(domains({ workspaces }), catalog(repos), view({ sortBy }))
    expect(outline(built.sectionRows)).toEqual([
      'ssh:box|r::/w/same@0',
      'local|r::/w/other@0',
      'local|r::/w/same@0'
    ])
  })

  it('keeps a sleeping row the host retains through a rebind gap', () => {
    const built = buildSidebarFeedRows(
      domains({
        workspaces,
        activity: new Map([['r::/w/other', { ...IDLE_WORKSPACE_ACTIVITY, browser: true }]]),
        retention: {
          retainedIds: [...workspaces.keys()].filter((key) => key.startsWith('ssh:')),
          retentionDecidedAt: 0
        }
      }),
      catalog(repos),
      view({ filters: { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true } })
    )
    expect(outline(built.sectionRows)).toEqual(['ssh:box|r::/w/same@0', 'local|r::/w/other@0'])
  })
})

describe('buildSidebarFeedRows nests each paired server’s own lineage', () => {
  const serverRows = (hostId: 'runtime:a' | 'runtime:b', recentAt: number) =>
    [
      { worktreeId: 'r::/r/p', worktreeInstanceId: `${hostId}-p`, lastActivityAt: recentAt },
      {
        worktreeId: 'r::/r/c',
        worktreeInstanceId: `${hostId}-c`,
        parentWorktreeId: 'r::/r/p',
        lineageWorktreeInstanceId: `${hostId}-c`,
        parentWorktreeInstanceId: `${hostId}-p`,
        lastActivityAt: recentAt + 1
      }
    ].flatMap((row) => normalizePairedServerRow(hostId, { repoId: 'r', ...row }) ?? [])
  const repos = [
    repo('r', { executionHostId: 'runtime:a' }),
    repo('r', { executionHostId: 'runtime:b' })
  ]
  const feed = (reversed: boolean, activity: SidebarFeedDomains['activity'] = new Map()) => {
    const rows = [...serverRows('runtime:a', 10), ...serverRows('runtime:b', 20)]
    return domains({
      activity,
      pairedServerHosts: new Map(
        ['runtime:a', 'runtime:b'].map((hostId) => [hostId, { freshness: 'live', host: null }])
      ),
      pairedServerRows: new Map((reversed ? rows.toReversed() : rows).map((row) => [row.key, row]))
    })
  }

  it.each([false, true])('in either server order (reversed: %s)', (reversed) => {
    const built = buildSidebarFeedRows(feed(reversed), catalog(repos), view())
    expect(outline(built.sectionRows)).toEqual([
      'runtime:b|r::/r/p@0',
      'runtime:b|r::/r/c@1',
      'runtime:a|r::/r/p@0',
      'runtime:a|r::/r/c@1'
    ])
  })

  it('brings back each server’s filtered-out parent above its own child', () => {
    // Activity is per bare id, so both servers' children are awake and both parents asleep.
    const awake = new Map([['r::/r/c', { ...IDLE_WORKSPACE_ACTIVITY, browser: true }]])
    const built = buildSidebarFeedRows(
      feed(false, awake),
      catalog(repos),
      view({ filters: { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true } })
    )
    expect(outline(built.sectionRows)).toEqual([
      'runtime:b|r::/r/p@0',
      'runtime:b|r::/r/c@1',
      'runtime:a|r::/r/p@0',
      'runtime:a|r::/r/c@1'
    ])
  })
})

function projectGroup(id: string, parentGroupId: string | null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('buildSidebarFeedRows host sections', () => {
  it('repeats a nested project group’s whole path in each host it spans', () => {
    const repos = [
      repo('near', { displayName: 'near', projectGroupId: 'H' }),
      repo('far', { displayName: 'far', connectionId: 'box', projectGroupId: 'H' })
    ]
    const workspaces = buildWorkspaceRows({
      worktrees: [worktree('near::/w/a'), worktree('far::/w/b', { hostId: 'ssh:box' })],
      folderWorkspaces: [],
      repos,
      lineageById: {}
    })
    const built = buildSidebarFeedRows(
      domains({ workspaces }),
      catalog(repos, [projectGroup('G', null), projectGroup('H', 'G')]),
      view({ groupBy: 'repo', visibleWorkspaceHostIds: ['local', 'ssh:box'] })
    )
    expect(outline(built.sectionRows)).toEqual([
      '## This computer',
      '# G@0',
      '# H@1',
      '# near@2',
      '|near::/w/a@0',
      '## box',
      '# G@0',
      '# H@1',
      '# far@2',
      'ssh:box|far::/w/b@0'
    ])
  })
})

describe('the desktop’s hover hold over the shared builder', () => {
  const repos = [repo('a'), repo('b')]
  const feedAt = (bRecent: number): SidebarFeedDomains =>
    domains({
      workspaces: buildWorkspaceRows({
        worktrees: [
          worktree('a::/w/1', { lastActivityAt: 100 }),
          worktree('b::/w/2', { lastActivityAt: bRecent })
        ],
        folderWorkspaces: [],
        repos,
        lineageById: {}
      })
    })
  const recentView = view({ groupBy: 'repo', sortBy: 'recent', projectOrderBy: 'recent' })
  const itemsOf = (rows: readonly HostSectionRow[]) =>
    outline(rows).filter((line) => !line.startsWith('#'))

  it('keeps project sections where they were while the pointer is over the list', () => {
    const engagedAt = indexSidebarFeed(feedAt(50), repos)
    const heldRanks = rankSidebarFeedWorktrees(engagedAt, 'recent')
    const live = feedAt(200)
    const liveIndex = indexSidebarFeed(live, repos)
    const shown = (index: SidebarFeedIndex) =>
      itemsOf(
        renderSidebarFeedRows(
          planSidebarFeedRows(live, index, catalog(repos), recentView, heldRanks),
          recentView,
          new Set()
        ).sectionRows
      )
    // Held workspace ranks alone let B's project jump above A's.
    expect(shown(liveIndex)).toEqual(['|b::/w/2@0', '|a::/w/1@0'])
    expect(shown(withHeldProjectRecency(liveIndex, engagedAt))).toEqual([
      '|a::/w/1@0',
      '|b::/w/2@0'
    ])
  })
})

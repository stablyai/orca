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
  buildSidebarFeedRows,
  planSidebarFeedRows,
  type SidebarFeedCatalog,
  type SidebarFeedView
} from './sidebar-feed-rows'
import { IDLE_WORKSPACE_ACTIVITY } from './workspace-activity-facts'
import { composeWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { buildWorkspaceRows } from './workspace-rows'
import {
  buildFeedHostOptions,
  indexSidebarFeed,
  rankSidebarFeedWorktrees
} from './sidebar-feed-index'
import { folderWorkspaceRepoId } from '../folder-workspaces/folder-workspace-worktree'

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

it('retires only recorded deletions through paired feed, pins, forced reveal and lineage', () => {
  const rows = [
    normalizePairedServerRow('runtime:a', {
      worktreeId: 'r::/p',
      repoId: 'r',
      worktreeInstanceId: 'p',
      isPinned: true,
      removing: true,
      removalRecorded: true
    }),
    normalizePairedServerRow('runtime:a', {
      worktreeId: 'r::/c',
      repoId: 'r',
      worktreeInstanceId: 'c',
      parentWorktreeId: 'r::/p',
      lineageWorktreeInstanceId: 'c',
      parentWorktreeInstanceId: 'p'
    }),
    normalizePairedServerRow('runtime:a', {
      worktreeId: 'r::/legacy',
      repoId: 'r',
      removing: true
    }),
    normalizePairedServerRow('runtime:a', {
      worktreeId: 'r::/failed',
      repoId: 'r',
      removalError: 'Cleanup failed. Retry deletion.'
    }),
    normalizePairedServerRow('runtime:b', { worktreeId: 'r::/p', repoId: 'r' })
  ].flatMap((row) => row ?? [])
  const repos = [
    repo('r', { executionHostId: 'runtime:a' }),
    repo('r', { executionHostId: 'runtime:b' })
  ]
  const inputs = domains({
    pairedServerHosts: new Map(
      ['runtime:a', 'runtime:b'].map((hostId) => [
        hostId,
        { freshness: 'live' as const, host: null }
      ])
    ),
    pairedServerRows: new Map(rows.map((row) => [row.key, row]))
  })
  const settings = view({ pinnedDisplayPolicy: 'duplicate-in-groups' })
  const index = indexSidebarFeed(inputs, repos)
  const planned = planSidebarFeedRows(
    inputs,
    index,
    catalog(repos),
    settings,
    rankSidebarFeedWorktrees(index, 'recent'),
    { forcedVisibleWorktreeIds: ['r::/p'] }
  )
  expect(planned.visibleWorktrees.map((row) => `${row.hostId}|${row.id}`).sort()).toEqual([
    'runtime:a|r::/c',
    'runtime:a|r::/failed',
    'runtime:a|r::/legacy',
    'runtime:b|r::/p'
  ])
  const built = buildSidebarFeedRows(inputs, catalog(repos), settings)
  expect(outline(built.sectionRows)).toContain('runtime:a|r::/c@0')
  expect(outline(built.sectionRows)).not.toContain('runtime:a|r::/p@0')
  expect(built.visibleWorktrees.find((row) => row.id === 'r::/failed')?.removalError).toBe(
    'Cleanup failed. Retry deletion.'
  )
})

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

  it('keeps a sleeping row the host retains through a rebind gap', () => {
    const built = buildSidebarFeedRows(
      domains({
        workspaces,
        activity: new Map([
          [
            composeWorktreeHostIdentity('local', 'r::/w/other'),
            { ...IDLE_WORKSPACE_ACTIVITY, browser: true }
          ]
        ]),
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

  const hideSleeping = view({
    filters: { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true }
  })
  const busy = { ...IDLE_WORKSPACE_ACTIVITY, browser: true }

  it('keeps one host’s activity off its same-id twin', () => {
    const activity = new Map([[composeWorktreeHostIdentity('ssh:box', 'r::/w/same'), busy]])
    const built = buildSidebarFeedRows(
      domains({ workspaces, activity }),
      catalog(repos),
      hideSleeping
    )
    expect(outline(built.sectionRows)).toEqual(['ssh:box|r::/w/same@0'])
  })

  it('keeps one host’s retention off its same-id twin', () => {
    const built = buildSidebarFeedRows(
      domains({
        workspaces,
        retention: {
          retainedIds: [composeWorktreeHostIdentity('local', 'r::/w/same')],
          retentionDecidedAt: 0
        }
      }),
      catalog(repos),
      hideSleeping
    )
    expect(outline(built.sectionRows)).toEqual(['local|r::/w/same@0'])
  })

  it('gives each twin’s row its own host’s registration of the repo', () => {
    const built = buildSidebarFeedRows(domains({ workspaces }), catalog(repos), view())
    const repoOf = (hostId: string) =>
      built.sectionRows.find(
        (row) =>
          row.type === 'item' && row.worktree.id === 'r::/w/same' && row.worktree.hostId === hostId
      )
    expect(repoOf('ssh:box')).toMatchObject({ repo: { connectionId: 'box' } })
    expect(repoOf('local')).toMatchObject({ repo: { id: 'r' } })
    expect(repoOf('local')).not.toMatchObject({ repo: { connectionId: 'box' } })
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

  it('brings back a server’s filtered-out parent above its own child, not its twin’s', () => {
    // Only server A's child is awake: B's same-id rows stay asleep.
    const awake = new Map([
      [
        composeWorktreeHostIdentity('runtime:a', 'r::/r/c'),
        { ...IDLE_WORKSPACE_ACTIVITY, browser: true }
      ]
    ])
    const built = buildSidebarFeedRows(
      feed(false, awake),
      catalog(repos),
      view({ filters: { ...NO_WORKSPACE_ROW_FILTERS, hideSleepingWorkspaces: true } })
    )
    expect(outline(built.sectionRows)).toEqual(['runtime:a|r::/r/p@0', 'runtime:a|r::/r/c@1'])
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

describe('buildSidebarFeedRows reads a row’s own registration of a repo two hosts register', () => {
  it('files and counts an unqualified local row under this computer, not the server', () => {
    // The server's registration of `r` comes last, so a lookup by repo id alone finds it.
    const repos = [repo('r'), repo('r', { executionHostId: 'runtime:env' })]
    const workspaces = buildWorkspaceRows({
      worktrees: [worktree('r::/w/a')],
      folderWorkspaces: [],
      repos: [repos[0]],
      lineageById: {}
    })
    const built = buildSidebarFeedRows(
      domains({ workspaces }),
      catalog(repos),
      view({ visibleWorkspaceHostIds: ['local'] })
    )
    expect(outline(built.sectionRows)).toEqual(['|r::/w/a@0'])
    const header = built.sectionRows.find((row) => row.type === 'header')
    expect(header).toMatchObject({ hostWorktreeIds: new Map([['local', ['r::/w/a']]]) })
  })
})

describe('buildSidebarFeedRows reads an older server’s edge without instance ids', () => {
  const rows = [
    { worktreeId: 'r::/r/p' },
    { worktreeId: 'r::/r/c', parentWorktreeId: 'r::/r/p' }
  ].flatMap((row) => normalizePairedServerRow('runtime:a', { repoId: 'r', ...row }) ?? [])
  const feed = domains({
    pairedServerHosts: new Map([['runtime:a', { freshness: 'live', host: null }]]),
    pairedServerRows: new Map(rows.map((row) => [row.key, row]))
  })
  const repos = [repo('r', { executionHostId: 'runtime:a' })]

  it('nests by it for the phone, which always has', () => {
    expect(
      outline(
        buildSidebarFeedRows(feed, catalog(repos), view(), { acceptLegacyLineage: true })
          .sectionRows
      )
    ).toEqual(['runtime:a|r::/r/p@0', 'runtime:a|r::/r/c@1'])
  })

  it('lists both standalone for desktop, which never has', () => {
    expect(outline(buildSidebarFeedRows(feed, catalog(repos), view()).sectionRows)).toEqual([
      'runtime:a|r::/r/c@0',
      'runtime:a|r::/r/p@0'
    ])
  })

  it('keeps an older server’s loop for the phone, as its direct list does', () => {
    const loop = [
      { worktreeId: 'r::/r/a', parentWorktreeId: 'r::/r/b' },
      { worktreeId: 'r::/r/b', parentWorktreeId: 'r::/r/a' }
    ].flatMap((row) => normalizePairedServerRow('runtime:a', { repoId: 'r', ...row }) ?? [])
    const looped = domains({
      pairedServerHosts: feed.pairedServerHosts,
      pairedServerRows: new Map(loop.map((row) => [row.key, row]))
    })
    expect(
      outline(
        buildSidebarFeedRows(looped, catalog(repos), view(), { acceptLegacyLineage: true })
          .sectionRows
      )
    ).toEqual(['runtime:a|r::/r/b@0', 'runtime:a|r::/r/a@1'])
  })
})

describe('buildSidebarFeedRows nests a server’s workspace under its folder workspace', () => {
  const group = { ...projectGroup('g', null), parentPath: '/r' }
  const rows = [
    {
      worktreeId: 'folder:f-1',
      repoId: folderWorkspaceRepoId('g'),
      workspaceKind: 'folder-workspace'
    },
    {
      worktreeId: 'r::/r/c',
      repoId: 'r',
      worktreeInstanceId: 'c-instance',
      workspaceLineage: {
        parentWorkspaceKey: 'folder:f-1',
        parentInstanceId: 'f-1',
        childInstanceId: 'c-instance'
      }
    }
  ].flatMap((row) => normalizePairedServerRow('runtime:a', row) ?? [])
  const feed = domains({
    pairedServerHosts: new Map([['runtime:a', { freshness: 'live', host: null }]]),
    pairedServerRows: new Map(rows.map((row) => [row.key, row]))
  })

  it('places the workspace under the folder in the folder’s project group', () => {
    const built = buildSidebarFeedRows(
      feed,
      catalog([repo('r', { executionHostId: 'runtime:a', projectGroupId: 'g' })], [group]),
      view({ groupBy: 'repo' })
    )
    expect(
      built.sectionRows.flatMap((row) =>
        row.type === 'folder-workspace'
          ? [`folder ${row.folderWorkspace.id}@${row.depth} children=${row.lineageChildCount}`]
          : row.type === 'item'
            ? [`${row.worktree.id}@${row.depth}`]
            : []
      )
    ).toEqual(['folder f-1@0 children=1', 'r::/r/c@1'])
  })
})

it('preserves a renamed paired host and marks the default local label', () => {
  const hosts = buildFeedHostOptions(
    domains({
      pairedServerHosts: new Map([
        [
          'runtime:a',
          {
            freshness: 'live',
            host: {
              label: 'Server',
              health: 'available',
              compatibility: null,
              pairedDeviceId: null
            }
          }
        ]
      ])
    }),
    [],
    view({ hostLabelOverrides: new Map([['runtime:a', 'Local Mac']]) })
  )
  expect(hosts.find((host) => host.id === 'runtime:a')?.label).toBe('Local Mac')
  expect(hosts.find((host) => host.id === 'local')?.isDefaultLocalLabel).toBe(true)
})

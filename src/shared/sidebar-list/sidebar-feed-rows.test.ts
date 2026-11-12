import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../execution-host'
import type { ProjectGroup } from '../project-group-types'
import type { Repo } from '../repo-types'
import { NO_WORKSPACE_ROW_FILTERS } from '../workspace-view/workspace-row-filters'
import { ALL_GROUP_KEY } from './group-keys'
import type { HostSectionRow } from './host-section-rows'
import { normalizePairedServerRow } from './paired-server-rows'
import type { SidebarFeedDomains } from './sidebar-feed-domains'
import {
  buildSidebarFeedRows,
  type SidebarFeedCatalog,
  type SidebarFeedView
} from './sidebar-feed-rows'
import { IDLE_WORKSPACE_ACTIVITY } from './workspace-activity-facts'
import { composeWorktreeHostIdentity } from '../worktree/host-qualified-identity'

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

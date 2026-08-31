/**
 * One automation ID under two authorities, followed from the cached host rows
 * all the way into the search index.
 *
 * These are the joins the list makes between a record and its host. Each one
 * used to be a bare automation ID, which is unique only inside one authority
 * (doc:38) — so the desktop's `a-1` and a runtime SSH host's `a-1` shared a
 * slot, and whichever was written last won it.
 */

import { describe, expect, it } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import type { AutomationHostCacheEntry, AutomationHostRow } from './automation-host-cache-types'
import type {
  AutomationHostCatalog,
  AutomationHostCatalogEntry
} from './automation-host-catalog-types'
import type { AutomationHostFilterResolution } from './automation-host-filter-resolution'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { resolveAutomationHostListRows } from './automation-host-list-rows'
import {
  buildAutomationListSearchRows,
  buildAutomationSearchRowSources,
  matchAutomationListSearchRowKeys
} from './automation-list-search-rows'
import { REPO_ID } from './automations-page-fixtures'
import { automationRepoForRow, automationWorktreeForRow } from './automation-list-row-identity'

const repoMap = new Map([
  [REPO_ID, { id: REPO_ID, displayName: 'orca', path: '/src/orca' } as Repo]
])

const DESKTOP_SELF: AutomationHostCatalogEntry = {
  stableRef: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
  owner: { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
  stableKey: 'host:desktop:self',
  label: 'This computer',
  authorityLabel: 'This computer',
  kind: 'self',
  catalogState: 'authoritative',
  authorityHealth: 'fresh',
  executionHealth: 'connected',
  querySupport: 'scoped'
}

const RUNTIME_SSH: AutomationHostCatalogEntry = {
  ...DESKTOP_SELF,
  stableRef: {
    authority: { kind: 'runtime', environmentId: 'gpu' },
    selector: { kind: 'ssh', targetId: 'web-01' }
  },
  owner: {
    authority: { kind: 'runtime', environmentId: 'gpu', pairingRevision: 4 },
    selector: { kind: 'ssh', targetId: 'web-01', targetGeneration: 2 }
  },
  stableKey: 'host:runtime:gpu:ssh:web-01',
  label: 'web-01',
  authorityLabel: 'GPU box',
  kind: 'ssh'
}

const ALL_HOSTS: AutomationHostFilterResolution = {
  effective: { kind: 'all' },
  entry: null,
  status: 'all',
  announceFallback: false
}

function cached(rows: AutomationHostRow[]): AutomationHostCacheEntry {
  return {
    data: rows,
    fetchedAt: 1,
    attempt: 0,
    requestGeneration: 0,
    catalogGeneration: 0,
    request: null,
    error: null,
    orphanCount: null
  }
}

function hostRow(entry: AutomationHostCatalogEntry, name: string): AutomationHostRow {
  return {
    automation: {
      id: 'a-1',
      name,
      prompt: 'sweep',
      projectId: REPO_ID,
      workspaceMode: 'new_per_run',
      baseBranch: null,
      agentId: 'claude'
    } as Automation,
    owner: entry.owner,
    selector: { kind: 'self' },
    usageSummary: null,
    usageKnown: true
  }
}

/** The desktop and a runtime SSH host each holding a record called `a-1`. */
function collidedListRows(): ReturnType<typeof resolveAutomationHostListRows> {
  const entries = [DESKTOP_SELF, RUNTIME_SSH]
  const catalog: AutomationHostCatalog = {
    entries,
    byStableKey: new Map(entries.map((entry) => [entry.stableKey, entry])),
    hydration: {
      runtimeCatalogSettled: true,
      desktopSshHydrated: true,
      runtimeSshHydratedByEnvironmentId: new Map(),
      savedRuntimeEnvironmentIds: new Set(),
      orphanSettledAuthorityKeys: new Set(),
      unavailableAuthorityKeys: new Set()
    }
  }
  return resolveAutomationHostListRows({
    catalog,
    resolution: ALL_HOSTS,
    entry: (stableKey) =>
      cached([
        stableKey === DESKTOP_SELF.stableKey
          ? hostRow(DESKTOP_SELF, 'Nightly desktop')
          : hostRow(RUNTIME_SSH, 'Nightly web-01')
      ])
  })
}

describe('automation list row identity across hosts', () => {
  it('lets each host’s row be found by its own host label', () => {
    const listRows = collidedListRows()
    const searchRows = buildAutomationListSearchRows(
      buildAutomationSearchRowSources(listRows.rows, { repoMap })
    )
    const nameByKey = new Map(listRows.rows.map((row) => [row.key, row.automation.name]))
    const namesMatching = (query: string): (string | undefined)[] =>
      matchAutomationListSearchRowKeys(searchRows, query).map((key) => nameByKey.get(key))

    expect(namesMatching('web-01')).toEqual(['Nightly web-01'])
    expect(namesMatching('this computer')).toEqual(['Nightly desktop'])
  })

  it('resolves colliding projects and worktrees inside each row authority', () => {
    const rows = collidedListRows().rows
    const repos = [
      { ...repoMap.get(REPO_ID)!, displayName: 'Desktop repo', executionHostId: 'local' as const },
      {
        ...repoMap.get(REPO_ID)!,
        displayName: 'Runtime repo',
        executionHostId: 'runtime:gpu' as const
      }
    ]
    const worktrees = [
      { id: 'ws-1', repoId: REPO_ID, hostId: 'local', displayName: 'Desktop workspace' },
      {
        id: 'ws-1',
        repoId: REPO_ID,
        hostId: 'runtime:gpu',
        displayName: 'Runtime workspace'
      }
    ] as Worktree[]
    const fallbackRepos = new Map([[REPO_ID, repos[1]]])
    const fallbackWorktrees = new Map([['ws-1', worktrees[1]]])

    expect(rows.map((row) => automationRepoForRow(row, repos, fallbackRepos)?.displayName)).toEqual(
      ['Desktop repo', 'Runtime repo']
    )
    expect(
      rows.map((row) => {
        const repo = automationRepoForRow(row, repos, fallbackRepos)
        return automationWorktreeForRow(
          row,
          { [REPO_ID]: worktrees },
          repo,
          fallbackWorktrees,
          'ws-1'
        )?.displayName
      })
    ).toEqual(['Desktop workspace', 'Runtime workspace'])
  })
})

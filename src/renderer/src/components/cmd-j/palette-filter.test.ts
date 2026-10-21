import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import {
  addPaletteFilterValues,
  buildPaletteFilterFromSidebarScope,
  buildPaletteFilterPredicate,
  clearPaletteFilterField,
  EMPTY_PALETTE_FILTER,
  getPaletteFilterSelectionCount,
  isPaletteFilterActive,
  togglePaletteFilterValue,
  type PaletteFilterState
} from './palette-filter'
import type { PaletteFilterModel } from './palette-filter-options'
import { buildPaletteFilterOptionSearchText } from './palette-filter-option-list'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

const option = (id: string, count = 1) => ({
  id,
  label: id,
  detail: '',
  count,
  searchText: buildPaletteFilterOptionSearchText(id, '')
})

// r1 + r2 are two repos behind one project row; r3 is a standalone repo row.
const model: PaletteFilterModel = {
  hosts: [option('local'), option('ssh:builder'), option('runtime:env-1')],
  repositories: [option('r1'), option('r2'), option('r3')],
  repoIdsByProjectKey: new Map([
    ['project:p1', ['r1', 'r2']],
    ['repo:r3', ['r3']]
  ]),
  hostIdsByRepoId: new Map<string, ReadonlySet<ExecutionHostId>>([
    ['r1', new Set(['local'])],
    ['r2', new Set(['ssh:builder'])],
    ['r3', new Set(['runtime:env-1'])]
  ]),
  repoById: new Map<string, Pick<Repo, 'connectionId' | 'executionHostId'>>([
    ['r1', {}],
    ['r2', { connectionId: 'builder' }],
    ['r3', { executionHostId: 'runtime:env-1' }]
  ]),
  defaultHostId: LOCAL_EXECUTION_HOST_ID
}

const filterOf = (hostIds: string[], repoIds: string[]): PaletteFilterState => ({
  hostIds,
  repoIds
})

describe('palette filter state', () => {
  it('reports activity and selection count across both fields', () => {
    expect(isPaletteFilterActive(EMPTY_PALETTE_FILTER)).toBe(false)
    expect(getPaletteFilterSelectionCount(EMPTY_PALETTE_FILTER)).toBe(0)
    expect(isPaletteFilterActive(filterOf([], ['r1']))).toBe(true)
    expect(getPaletteFilterSelectionCount(filterOf(['local'], ['r1']))).toBe(2)
  })

  it('toggles values on and off, keeping each field sorted', () => {
    const withHost = togglePaletteFilterValue(EMPTY_PALETTE_FILTER, 'host', 'ssh:builder')
    const withBothHosts = togglePaletteFilterValue(withHost, 'host', 'local')

    expect(withBothHosts.hostIds).toEqual(['local', 'ssh:builder'])
    expect(withBothHosts.repoIds).toEqual([])
    expect(togglePaletteFilterValue(withBothHosts, 'host', 'local').hostIds).toEqual([
      'ssh:builder'
    ])
  })

  it('keeps the two fields independent', () => {
    const filter = togglePaletteFilterValue(
      togglePaletteFilterValue(EMPTY_PALETTE_FILTER, 'host', 'local'),
      'repository',
      'r1'
    )

    expect(clearPaletteFilterField(filter, 'repository')).toEqual(filterOf(['local'], []))
    expect(clearPaletteFilterField(filter, 'host')).toEqual(filterOf([], ['r1']))
  })

  it('bulk-adds every matching id without duplicating', () => {
    const withOne = addPaletteFilterValues(EMPTY_PALETTE_FILTER, 'repository', ['r1', 'r3', 'r1'])
    expect(withOne.repoIds).toEqual(['r1', 'r3'])

    const manyIds = Array.from({ length: 501 }, (_, index) => `repo-${index}`)
    expect(
      addPaletteFilterValues(EMPTY_PALETTE_FILTER, 'repository', manyIds).repoIds
    ).toHaveLength(501)
  })

  it('preserves state identity when bulk-add and clear are no-ops', () => {
    const filter = filterOf(['local'], ['r1'])
    const repoOnly = filterOf([], ['r1'])

    expect(addPaletteFilterValues(filter, 'repository', ['r1'])).toBe(filter)
    expect(clearPaletteFilterField(filter, 'host')).not.toBe(filter)
    expect(clearPaletteFilterField(repoOnly, 'host')).toBe(repoOnly)
  })
})

describe('buildPaletteFilterPredicate', () => {
  it('returns null when no filter is active so callers can skip the pass', () => {
    expect(buildPaletteFilterPredicate(EMPTY_PALETTE_FILTER, model)).toBeNull()
  })

  it('matches worktrees on the host axis, preferring the worktree stamp over the repo', () => {
    const predicate = buildPaletteFilterPredicate(filterOf(['ssh:builder'], []), model)

    expect(predicate?.matchesWorktree({ repoId: 'r2' })).toBe(true)
    expect(predicate?.matchesWorktree({ repoId: 'r1' })).toBe(false)
    // A workspace stamped onto another host follows its own stamp, not the repo's.
    expect(predicate?.matchesWorktree({ repoId: 'r1', hostId: 'ssh:builder' })).toBe(true)
    expect(predicate?.matchesWorktree({ repoId: 'r2', hostId: 'local' })).toBe(false)
  })

  it('treats an unknown repo as local', () => {
    const local = buildPaletteFilterPredicate(filterOf(['local'], []), model)

    expect(local?.matchesWorktree({ repoId: 'never-seen' })).toBe(true)
  })

  it('keeps repository filtering exact within a multi-repo project row', () => {
    const predicate = buildPaletteFilterPredicate(filterOf([], ['r1']), model)

    expect(predicate?.matchesWorktree({ repoId: 'r1' })).toBe(true)
    expect(predicate?.matchesWorktree({ repoId: 'r2' })).toBe(false)
    expect(predicate?.matchesWorktree({ repoId: 'r3' })).toBe(false)
    expect(predicate?.matchesProjectRowKey('project:p1')).toBe(true)
    expect(predicate?.matchesProjectRowKey('repo:r3')).toBe(false)
  })

  it('keeps a project row whose repos straddle hosts under either host filter', () => {
    // project:p1 is checked out on local (r1) and ssh:builder (r2) — filtering to
    // either host must keep the single row that represents both.
    for (const hostId of ['local', 'ssh:builder']) {
      const predicate = buildPaletteFilterPredicate(filterOf([hostId], []), model)
      expect(predicate?.matchesProjectRowKey('project:p1')).toBe(true)
    }

    const runtimeOnly = buildPaletteFilterPredicate(filterOf(['runtime:env-1'], []), model)
    expect(runtimeOnly?.matchesProjectRowKey('project:p1')).toBe(false)
    expect(runtimeOnly?.matchesProjectRowKey('repo:r3')).toBe(true)
  })

  it('ORs within a field and ANDs across fields', () => {
    const ored = buildPaletteFilterPredicate(filterOf([], ['r1', 'r3']), model)
    expect(ored?.matchesWorktree({ repoId: 'r1' })).toBe(true)
    expect(ored?.matchesWorktree({ repoId: 'r3' })).toBe(true)

    const anded = buildPaletteFilterPredicate(filterOf(['local'], ['r1', 'r2']), model)
    expect(anded?.matchesWorktree({ repoId: 'r1' })).toBe(true)
    expect(anded?.matchesWorktree({ repoId: 'r2' })).toBe(false)
    expect(anded?.matchesProjectRowKey('project:p1')).toBe(true)
    expect(anded?.matchesProjectRowKey('repo:r3')).toBe(false)

    const disjoint = buildPaletteFilterPredicate(filterOf(['local'], ['r2']), model)
    expect(disjoint?.matchesProjectRowKey('project:p1')).toBe(false)
  })

  it('matches every host that owns a shared repository ID', () => {
    const sharedRepoModel: PaletteFilterModel = {
      ...model,
      repositories: [option('shared')],
      repoIdsByProjectKey: new Map([['repo:shared', ['shared']]]),
      hostIdsByRepoId: new Map([['shared', new Set(['local', 'ssh:builder'])]])
    }

    expect(
      buildPaletteFilterPredicate(
        filterOf(['ssh:builder'], ['shared']),
        sharedRepoModel
      )?.matchesProjectRowKey('repo:shared')
    ).toBe(true)
  })

  it('never matches a stale repository id', () => {
    const predicate = buildPaletteFilterPredicate(filterOf([], ['repo:gone']), model)

    expect(predicate?.matchesWorktree({ repoId: 'r1' })).toBe(false)
    expect(predicate?.matchesProjectRowKey('project:p1')).toBe(false)
  })

  it('keeps group rows on the host axis only', () => {
    const hostOnly = buildPaletteFilterPredicate(filterOf(['ssh:builder'], []), model)
    expect(hostOnly?.matchesGroupHostId('ssh:builder')).toBe(true)
    expect(hostOnly?.matchesGroupHostId('local')).toBe(false)

    // A group header belongs to no repository, so any repository selection excludes it.
    const withProject = buildPaletteFilterPredicate(filterOf(['ssh:builder'], ['r2']), model)
    expect(withProject?.matchesGroupHostId('ssh:builder')).toBe(false)
  })
})

describe('buildPaletteFilterFromSidebarScope', () => {
  const allHosts = { workspaceHostScope: 'all', visibleWorkspaceHostIds: null } as const

  it('opens unfiltered when the sidebar shows every host and project', () => {
    expect(buildPaletteFilterFromSidebarScope({ ...allHosts, filterRepoIds: [] })).toBe(
      EMPTY_PALETTE_FILTER
    )
  })

  it('seeds the host chips from the sidebar host scope', () => {
    expect(
      buildPaletteFilterFromSidebarScope({
        workspaceHostScope: 'ssh:builder',
        visibleWorkspaceHostIds: null,
        filterRepoIds: []
      })
    ).toEqual(filterOf(['ssh:builder'], []))
    expect(
      buildPaletteFilterFromSidebarScope({
        workspaceHostScope: 'all',
        visibleWorkspaceHostIds: ['runtime:env-1', 'local'],
        filterRepoIds: []
      })
    ).toEqual(filterOf(['local', 'runtime:env-1'], []))
  })

  it('preserves sidebar repository picks exactly', () => {
    expect(buildPaletteFilterFromSidebarScope({ ...allHosts, filterRepoIds: ['r2'] })).toEqual(
      filterOf([], ['r2'])
    )

    const predicate = buildPaletteFilterPredicate(filterOf([], ['r2']), model)
    expect(predicate?.matchesWorktree({ repoId: 'r1' })).toBe(false)
    expect(predicate?.matchesWorktree({ repoId: 'r2' })).toBe(true)
  })

  it('preserves explicit selections even when they currently cover every known option', () => {
    expect(
      buildPaletteFilterFromSidebarScope({
        workspaceHostScope: 'all',
        visibleWorkspaceHostIds: ['local', 'ssh:builder', 'runtime:env-1'],
        filterRepoIds: ['r1', 'r2', 'r3']
      })
    ).toEqual(filterOf(['local', 'runtime:env-1', 'ssh:builder'], ['r1', 'r2', 'r3']))
  })

  it('preserves empty or stale scopes instead of widening to a global search', () => {
    const filter = buildPaletteFilterFromSidebarScope({
      workspaceHostScope: 'ssh:gone',
      visibleWorkspaceHostIds: null,
      filterRepoIds: ['r-gone']
    })

    expect(filter).toEqual(filterOf(['ssh:gone'], ['r-gone']))
    expect(buildPaletteFilterPredicate(filter, model)?.matchesWorktree({ repoId: 'r1' })).toBe(
      false
    )
  })
})

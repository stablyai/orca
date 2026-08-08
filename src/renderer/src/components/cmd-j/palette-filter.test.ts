import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  addPaletteFilterValues,
  buildPaletteFilterPredicate,
  clearPaletteFilterField,
  EMPTY_PALETTE_FILTER,
  getPaletteFilterSelectionCount,
  isPaletteFilterActive,
  PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD,
  reconcilePaletteFilter,
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
  projects: [option('project:p1'), option('repo:r3')],
  repoIdsByProjectKey: new Map([
    ['project:p1', ['r1', 'r2']],
    ['repo:r3', ['r3']]
  ]),
  hostIdByRepoId: new Map<string, ExecutionHostId>([
    ['r1', 'local'],
    ['r2', 'ssh:builder'],
    ['r3', 'runtime:env-1']
  ]),
  defaultHostId: LOCAL_EXECUTION_HOST_ID
}

const filterOf = (hostIds: string[], projectKeys: string[]): PaletteFilterState => ({
  hostIds,
  projectKeys
})

describe('palette filter state', () => {
  it('reports activity and selection count across both fields', () => {
    expect(isPaletteFilterActive(EMPTY_PALETTE_FILTER)).toBe(false)
    expect(getPaletteFilterSelectionCount(EMPTY_PALETTE_FILTER)).toBe(0)
    expect(isPaletteFilterActive(filterOf([], ['project:p1']))).toBe(true)
    expect(getPaletteFilterSelectionCount(filterOf(['local'], ['project:p1']))).toBe(2)
  })

  it('toggles values on and off, keeping each field sorted', () => {
    const withHost = togglePaletteFilterValue(EMPTY_PALETTE_FILTER, 'host', 'ssh:builder')
    const withBothHosts = togglePaletteFilterValue(withHost, 'host', 'local')

    expect(withBothHosts.hostIds).toEqual(['local', 'ssh:builder'])
    expect(withBothHosts.projectKeys).toEqual([])
    expect(togglePaletteFilterValue(withBothHosts, 'host', 'local').hostIds).toEqual([
      'ssh:builder'
    ])
  })

  it('keeps the two fields independent', () => {
    const filter = togglePaletteFilterValue(
      togglePaletteFilterValue(EMPTY_PALETTE_FILTER, 'host', 'local'),
      'project',
      'project:p1'
    )

    expect(clearPaletteFilterField(filter, 'project')).toEqual(filterOf(['local'], []))
    expect(clearPaletteFilterField(filter, 'host')).toEqual(filterOf([], ['project:p1']))
  })

  it('refuses selections past the per-field cap', () => {
    const saturated = filterOf(
      Array.from({ length: PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD }, (_, i) => `ssh:host-${i}`),
      []
    )

    const next = togglePaletteFilterValue(saturated, 'host', 'ssh:one-too-many')

    expect(next.hostIds).toHaveLength(PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD)
    expect(next.hostIds).not.toContain('ssh:one-too-many')
    // Deselecting still works at the cap, so the user is never stuck.
    expect(togglePaletteFilterValue(saturated, 'host', 'ssh:host-0').hostIds).toHaveLength(
      PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD - 1
    )
  })

  it('bulk-adds matching ids up to the per-field cap without duplicating', () => {
    const withOne = addPaletteFilterValues(EMPTY_PALETTE_FILTER, 'project', [
      'project:p1',
      'repo:r3',
      'project:p1'
    ])
    expect(withOne.projectKeys).toEqual(['project:p1', 'repo:r3'])

    const nearCap = filterOf(
      Array.from(
        { length: PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD - 1 },
        (_, i) => `ssh:host-${i}`
      ),
      []
    )
    const filled = addPaletteFilterValues(nearCap, 'host', ['ssh:a', 'ssh:b'])
    expect(filled.hostIds).toHaveLength(PALETTE_FILTER_MAX_SELECTIONS_PER_FIELD)
    expect(filled.hostIds).toContain('ssh:a')
    expect(filled.hostIds).not.toContain('ssh:b')
  })
})

describe('reconcilePaletteFilter', () => {
  it('returns the same reference when every selection still exists', () => {
    const filter = filterOf(['local'], ['project:p1'])

    expect(reconcilePaletteFilter(filter, model)).toBe(filter)
    expect(reconcilePaletteFilter(EMPTY_PALETTE_FILTER, model)).toBe(EMPTY_PALETTE_FILTER)
  })

  it('drops selections whose host or project disappeared', () => {
    const filter = filterOf(['local', 'ssh:deleted'], ['project:p1', 'repo:removed'])

    expect(reconcilePaletteFilter(filter, model)).toEqual(filterOf(['local'], ['project:p1']))
  })

  it('empties a filter whose every selection is gone', () => {
    const reconciled = reconcilePaletteFilter(filterOf(['ssh:deleted'], []), model)

    expect(isPaletteFilterActive(reconciled)).toBe(false)
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

  it('matches every repo behind a multi-repo project row', () => {
    const predicate = buildPaletteFilterPredicate(filterOf([], ['project:p1']), model)

    expect(predicate?.matchesWorktree({ repoId: 'r1' })).toBe(true)
    expect(predicate?.matchesWorktree({ repoId: 'r2' })).toBe(true)
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
    const ored = buildPaletteFilterPredicate(filterOf([], ['project:p1', 'repo:r3']), model)
    expect(ored?.matchesWorktree({ repoId: 'r1' })).toBe(true)
    expect(ored?.matchesWorktree({ repoId: 'r3' })).toBe(true)

    // Project p1 spans local (r1) and ssh:builder (r2); adding the host axis
    // narrows to the intersection rather than widening the result set.
    const anded = buildPaletteFilterPredicate(filterOf(['local'], ['project:p1']), model)
    expect(anded?.matchesWorktree({ repoId: 'r1' })).toBe(true)
    expect(anded?.matchesWorktree({ repoId: 'r2' })).toBe(false)
    expect(anded?.matchesProjectRowKey('project:p1')).toBe(true)
    expect(anded?.matchesProjectRowKey('repo:r3')).toBe(false)
  })

  it('never matches a stale project key that resolves to no repos', () => {
    const predicate = buildPaletteFilterPredicate(filterOf([], ['project:gone']), model)

    expect(predicate?.matchesWorktree({ repoId: 'r1' })).toBe(false)
    expect(predicate?.matchesProjectRowKey('project:p1')).toBe(false)
  })

  it('keeps group rows on the host axis only', () => {
    const hostOnly = buildPaletteFilterPredicate(filterOf(['ssh:builder'], []), model)
    expect(hostOnly?.matchesGroupHostId('ssh:builder')).toBe(true)
    expect(hostOnly?.matchesGroupHostId('local')).toBe(false)

    // A group header belongs to no project, so any project selection excludes it.
    const withProject = buildPaletteFilterPredicate(
      filterOf(['ssh:builder'], ['project:p1']),
      model
    )
    expect(withProject?.matchesGroupHostId('ssh:builder')).toBe(false)
  })
})

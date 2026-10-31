import { worktree as worktreeBase } from '../sidebar/worktree-list-groups-test-fixtures'
import {
  addPaletteFilterValues,
  buildPaletteFilterPredicate,
  getPaletteProjectSelection
} from './palette-filter'
import { describe, expect, it, vi } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { buildPaletteFilterModel } from './palette-filter-options'
import { hasCmdJProjectSearchCandidates, searchCmdJProjectResults } from './palette-project-results'

describe('palette project grouping operation bound', () => {
  it.each([100, 1000])('indexes %i projects once per presence, query and filter pass', (count) => {
    const repos = Array.from({ length: count }, (_, index) => ({
      id: `repo-${index}`,
      path: `/repos/${index}`,
      displayName: `app-${index}`,
      badgeColor: '',
      addedAt: 0
    }))
    const projection = projectHostSetupProjectionFromRepos(repos)
    let reads = 0
    const projects = projection.projects.map((project) => ({
      ...project,
      get id() {
        reads++
        return project.id
      }
    }))
    const input = { repos, projects, projectHostSetups: projection.setups, projectGroups: [] }
    expect(hasCmdJProjectSearchCandidates(input)).toBe(true)
    expect(reads).toBeLessThanOrEqual(10 * count)
    reads = 0
    expect(searchCmdJProjectResults({ ...input, query: 'app' })).toHaveLength(count)
    expect(reads).toBeLessThanOrEqual(10 * count)
    reads = 0
    const filters = buildPaletteFilterModel({ ...input, worktrees: [], hostOptions: [] })
    expect(filters.repoIdsByProjectKey.size).toBe(count)
    expect(reads).toBeLessThanOrEqual(10 * count)
  })
})

it.each(['workspaces', 'filters', 'groups'] as const)(
  'bounds the actual grouped palette prepare/edit/predicate operation with independent %s N/10N',
  (dimension) => {
    for (const n of [100, 1000]) {
      const repos = Array.from({ length: 1000 }, (_, i) => ({
        id: `palette-${i}`,
        path: `/repos/${i}`,
        displayName: `App ${i}`,
        badgeColor: '',
        addedAt: 0
      }))
      const projection = projectHostSetupProjectionFromRepos(repos)
      const count = dimension === 'workspaces' ? n : 1000
      const groups = dimension === 'groups' ? n : 1000
      const setups = projection.setups.map((setup, i) => ({
        ...setup,
        projectId: projection.projects[i % groups].id
      }))
      const rows = Array.from({ length: count }, (_, i) => ({
        ...worktreeBase,
        id: `row-${i}`,
        repoId: repos[i].id,
        path: `/repos/${i}/row`
      }))
      const get = Map.prototype.get
      let operations = 0
      const probe = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown
      ) {
        operations++
        return get.call(this, key)
      })
      try {
        const model = buildPaletteFilterModel({
          repos,
          projects: projection.projects.slice(0, groups),
          projectHostSetups: setups,
          worktrees: rows,
          hostOptions: []
        })
        const selected = dimension === 'filters' ? n : groups
        const filter = addPaletteFilterValues(
          { hostIds: [], repoIds: ['unavailable'] },
          'repository',
          model.repositories.slice(0, selected).map((option) => option.id),
          model
        )
        expect(getPaletteProjectSelection(model, filter.repoIds).matching.size).toBe(selected)
        const predicate = buildPaletteFilterPredicate(filter, model)!
        expect(rows.filter(predicate.matchesWorktree).length).toBe(
          dimension === 'filters' ? n : count
        )
        expect(operations).toBeGreaterThan(1000)
        expect(operations).toBeLessThan(80 * (1000 + count + selected + groups))
        process.stdout.write(
          `PG8 palette operations ${JSON.stringify({ dimension, n, r: 1000, w: count, f: filter.repoIds.length, groups, operations })}\n`
        )
      } finally {
        probe.mockRestore()
      }
    }
  }
)

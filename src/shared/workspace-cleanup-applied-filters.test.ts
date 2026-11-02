import { describe, expect, it } from 'vitest'
import { createDefaultWorkspaceCleanupFilterState } from './workspace-cleanup-filter-model'
import { listAppliedWorkspaceCleanupFilters } from './workspace-cleanup-applied-filters'

const FORMAT = {
  idleDays: (d: number) => `Idle >= ${d}d`,
  neverVisited: () => 'Never visited',
  minSize: (b: number) => `At least ${b}B`,
  maxSize: (b: number) => `At most ${b}B`,
  excludesUnsized: () => 'Excludes unmeasured',
  excludesStatusless: () => 'Excludes statusless',
  list: (kind: string, count: number) => `${kind}:${count}`,
  triState: (kind: string, mode: string) => `${kind}:${mode}`,
  minAhead: (n: number) => `Ahead >= ${n}`,
  minBehind: (n: number) => `Behind >= ${n}`,
  branchQuery: (v: string) => `Branch ~ ${v}`,
  pathPrefix: (v: string) => `Path ~ ${v}`,
  presence: (kind: string, mode: string) => `${kind}:${mode}`,
  completelyEmpty: () => 'Nothing to lose'
}

const list = (f: ReturnType<typeof createDefaultWorkspaceCleanupFilterState>) =>
  listAppliedWorkspaceCleanupFilters(f, FORMAT)

describe('listAppliedWorkspaceCleanupFilters', () => {
  it('clears one constraint and leaves the rest of its own group alone', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.activity.idleMinDays = 20
    filters.activity.neverVisited = true

    const idle = list(filters).find((a) => a.id === 'activity.idleMinDays')
    const next = idle!.clear(filters)

    expect(next.activity.idleMinDays).toBeNull()
    expect(next.activity.neverVisited).toBe(true)
  })

  it('never mutates the filters it is handed', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.location.pathPrefix = '/repos'

    list(filters)[0].clear(filters)

    expect(filters.location.pathPrefix).toBe('/repos')
  })

  describe('numeric zero', () => {
    it('hides an inert zero minimum, which matches every row', () => {
      const filters = createDefaultWorkspaceCleanupFilterState()
      filters.activity.idleMinDays = 0
      filters.size.minBytes = 0
      filters.git.minAhead = 0
      filters.git.minBehind = 0

      expect(list(filters)).toEqual([])
    })

    it('shows a zero maximum, which hides every measured non-empty workspace', () => {
      const filters = createDefaultWorkspaceCleanupFilterState()
      filters.size.maxBytes = 0

      expect(list(filters).map((a) => a.id)).toEqual(['size.maxBytes'])
    })
  })

  it('ignores whitespace-only text', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.git.branchQuery = '   '
    filters.location.pathPrefix = '  '

    expect(list(filters)).toEqual([])
  })

  it('clearing every chip in turn returns the profile to no constraints', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.activity.idleMinDays = 20
    filters.size.maxBytes = 0
    filters.size.includeUnsized = false
    filters.status.matchStatusless = false
    filters.git.branchQuery = 'release'
    filters.location.pathPrefix = '/repos'
    filters.safety.dismissed = 'only'

    let next = filters
    for (const applied of list(filters)) {
      next = applied.clear(next)
    }

    expect(list(next)).toEqual([])
  })

  it('leaves the search query alone, which chips do not own', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.query = 'release'
    filters.activity.idleMinDays = 20

    const next = list(filters)[0].clear(filters)

    expect(next.query).toBe('release')
  })
})

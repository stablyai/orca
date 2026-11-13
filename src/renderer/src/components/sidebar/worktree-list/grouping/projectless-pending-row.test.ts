// GH-CREATE-NO-ROW: a create with no project here yet (a GitHub-only Orca Cloud create) has a
// pending row atop the list when grouped by project, as in every other grouping; a create with a
// project still sits atop its own project.
import { describe, expect, it } from 'vitest'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import { buildRows } from './build-rows.test-fixture'

function rows(groupBy: 'repo' | 'none', pending: { creationId: string; repoId: string }[]) {
  return buildRows(
    groupBy,
    [{ ...worktree, lastActivityAt: 1 }],
    new Map([[repo.id, repo]]),
    null,
    new Set(),
    undefined,
    undefined,
    'manual',
    {},
    undefined,
    false,
    undefined,
    [],
    new Set(),
    new Map(),
    new Map(),
    pending
  )
}

describe('pending row for a create with no project yet', () => {
  it('by project: sits atop the list, before the first project header', () => {
    const list = rows('repo', [{ creationId: 'gh-1', repoId: '' }])
    expect(list[0]).toMatchObject({ type: 'pending-creation', creationId: 'gh-1' })
    expect(list.filter((row) => row.type === 'pending-creation')).toHaveLength(1)
    // No blank project header for it (it used to get one, keyed "repo:").
    expect(list.filter((row) => row.type === 'header')).toHaveLength(1)
  })

  it('by project: a create with a project still sits atop that project only', () => {
    const list = rows('repo', [{ creationId: 'local-1', repoId: repo.id }])
    const header = list.findIndex((row) => row.type === 'header')
    expect(header).toBeGreaterThanOrEqual(0)
    expect(list.findIndex((row) => row.type === 'pending-creation')).toBeGreaterThan(header)
    expect(list.filter((row) => row.type === 'pending-creation')).toHaveLength(1)
  })

  it('ungrouped: unchanged, every pending row on top', () => {
    const list = rows('none', [{ creationId: 'gh-1', repoId: '' }])
    expect(list[0]).toMatchObject({ type: 'pending-creation', creationId: 'gh-1' })
  })
})

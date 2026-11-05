import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows.test-fixture'
import { repo, worktree } from './worktree-list-groups-test-fixtures'

import type { Repo } from '../../../../../../shared/repo-types'

describe('buildRows project grouping order', () => {
  // A stale sibling precedes A’s fresh child to require max-child activity ranking.

  it('builds rows for a very large repo-group list', () => {
    const count = 130_000
    const repos = new Map<string, Repo>()
    const worktrees = Array.from({ length: count }, (_, index) => {
      const repoId = `repo-${index}`
      repos.set(repoId, { ...repo, id: repoId, displayName: `repo ${index}` })
      return { ...worktree, id: `wt-${index}`, repoId, displayName: `workspace ${index}` }
    })

    const rows = buildRows('repo', worktrees, repos, null, new Set())

    expect(rows).toHaveLength(count * 2)
    expect(rows[0]).toMatchObject({ type: 'header', key: 'repo:repo-0' })
    expect(rows.at(-1)).toMatchObject({ type: 'item', worktree: { id: 'wt-129999' } })
  })
})

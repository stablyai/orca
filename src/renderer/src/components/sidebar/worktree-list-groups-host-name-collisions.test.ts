import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows.test-fixture'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import type { Repo } from '../../../../shared/repo-types'

const local: Repo = {
  ...repo,
  id: 'local-app',
  path: '/home/user/projects/app',
  displayName: 'app'
}
const paired: Repo = { ...local, id: 'home-app', executionHostId: 'runtime:home' }

describe('project labels across execution hosts', () => {
  it('keeps identical local and paired project paths short while preserving host labels', () => {
    const worktrees = [
      { ...worktree, id: 'local-workspace', repoId: local.id, hostId: 'local' as const },
      { ...worktree, id: 'home-workspace', repoId: paired.id, hostId: 'runtime:home' as const }
    ]
    const rows = buildRows(
      'repo',
      worktrees,
      new Map([
        [local.id, local],
        [paired.id, paired]
      ]),
      null,
      new Set()
    )
    expect(rows.filter((row) => row.type === 'header').map((row) => row.label)).toEqual([
      'app',
      'app'
    ])
    const items = rows.filter((row) => row.type === 'item')
    expect(items.map((row) => row.worktree.hostId)).toEqual(['local', 'runtime:home'])
    expect(items[0]?.hostContextLabel).toBeTruthy()
    expect(items[1]?.hostContextLabel).toBeTruthy()
    expect(items[0]?.hostContextLabel).not.toBe(items[1]?.hostContextLabel)
  })
})

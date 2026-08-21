import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import { buildRows } from './build-rows'

const repo: Repo = {
  id: 'repo-1',
  path: '/repos/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

function makeWorktree(id: string, isMainWorktree: boolean): Worktree {
  return {
    id,
    repoId: repo.id,
    path: `/repos/app/${id}`,
    branch: id,
    displayName: id,
    isMainWorktree
  } as Worktree as Worktree
}

// A child workspace sorted ahead of the main by createdAt (Recent-style input order).
const childFirst = makeWorktree('child-hot', false)
const main = makeWorktree('main', true)
const repoMap = new Map([[repo.id, repo]])

describe('buildRows main-workspace pinning (#15770)', () => {
  it('anchors the main workspace at the top of its repo group by default', () => {
    const rows = buildRows('repo', [childFirst, main], repoMap, null, new Set())
    const itemIds = rows
      .filter((row) => row.type === 'item')
      .map((row) => (row.type === 'item' ? row.worktree.id : ''))
    expect(itemIds).toEqual(['main', 'child-hot'])
  })

  it('lets the natural order rank the main workspace when pinMainWorkspaceFirst is off', () => {
    const settings = { pinMainWorkspaceFirst: false } as AppState['settings']
    const rows = buildRows(
      'repo',
      [childFirst, main],
      repoMap,
      null,
      new Set(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      settings
    )
    const itemIds = rows
      .filter((row) => row.type === 'item')
      .map((row) => (row.type === 'item' ? row.worktree.id : ''))
    expect(itemIds).toEqual(['child-hot', 'main'])
  })
})

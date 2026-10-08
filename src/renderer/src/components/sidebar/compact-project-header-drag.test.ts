import { describe, expect, it } from 'vitest'
import { buildRows } from './worktree-list/grouping/build-rows'
import { getSidebarOrderedRepoHeaderIdsByBucket } from './project-header-drop'
import { getRepoHeaderSectionEndByRepoId } from './worktree-header-section-boundaries'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

const repoA: Repo = { ...repo, id: 'repo-a', path: '/tmp/a', displayName: 'alpha' }
const repoB: Repo = { ...repo, id: 'repo-b', path: '/tmp/b', displayName: 'beta' }
const repoC: Repo = { ...repo, id: 'repo-c', path: '/tmp/c', displayName: 'gamma' }

function wt(id: string, repoId: string): Worktree {
  return { ...worktree, id, repoId, path: `/tmp/${id}`, displayName: id }
}

describe('compact project rows in Manual project drag', () => {
  const rows = buildRows(
    'repo',
    [wt('wt-a', repoA.id), wt('wt-b1', repoB.id), wt('wt-b2', repoB.id), wt('wt-c', repoC.id)],
    new Map([repoA, repoB, repoC].map((r) => [r.id, r])),
    null,
    new Set(),
    new Map([
      [repoA.id, 0],
      [repoB.id, 1],
      [repoC.id, 2]
    ]),
    undefined,
    'manual',
    {},
    undefined,
    false,
    { ...getDefaultSettings('/tmp'), compactProjectRows: true }
  )

  it('counts folded rows as project headers, in render order', () => {
    expect(getSidebarOrderedRepoHeaderIdsByBucket(rows).get('ungrouped')).toEqual([
      'repo-a',
      'repo-b',
      'repo-c'
    ])
  })

  it('bounds each project section at the next compact row', () => {
    const idsByBucket = getSidebarOrderedRepoHeaderIdsByBucket(rows)
    const sectionEnds = getRepoHeaderSectionEndByRepoId({
      rows,
      firstHeaderIndex: 0,
      sidebarRepoHeaderIdsByBucket: idsByBucket,
      repoHeaderBucketByRepoId: new Map(
        ['repo-a', 'repo-b', 'repo-c'].map((id) => [id, 'ungrouped'])
      )
    })
    expect(sectionEnds.get('repo-a')).toBeLessThan(sectionEnds.get('repo-b') ?? 0)
    expect(sectionEnds.get('repo-b')).toBeLessThan(sectionEnds.get('repo-c') ?? 0)
  })
})

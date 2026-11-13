// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ProjectHeaderDragBucketKey } from './project-header-drop'
import { useProjectHeaderMoveToTop } from './project-header-move-to-top'

function repo(id: string, extra: Partial<Repo> = {}): Repo {
  return { id, path: `/repos/${id}`, displayName: id, badgeColor: '', addedAt: 0, ...extra }
}

function setup(args: {
  repos: Repo[]
  byBucket: Map<ProjectHeaderDragBucketKey, string[]>
  byHostBucket?: Map<string, string[]>
  rootProjectHeaderKeys?: string[]
  usesProjectGroupOrdering?: boolean
}) {
  const onCommitRepoOrder = vi.fn()
  const onCommitProjectGroupOrder = vi.fn()
  const onCommitRootProjectOrder = vi.fn()
  const { result } = renderHook(() =>
    useProjectHeaderMoveToTop({
      orderedRepoIds: args.repos.map((r) => r.id),
      sidebarRepoHeaderIdsByBucket: args.byBucket,
      sidebarRepoHeaderIdsByHostBucket: args.byHostBucket,
      repoById: new Map(args.repos.map((r) => [r.id, r])),
      getLiveRepos: () => args.repos,
      usesProjectGroupOrdering: args.usesProjectGroupOrdering ?? false,
      onCommitRepoOrder,
      onCommitProjectGroupOrder,
      rootProjectHeaderKeys: args.rootProjectHeaderKeys,
      onCommitRootProjectOrder,
      getScrollContainer: () => null
    })
  )
  return { result, onCommitRepoOrder, onCommitProjectGroupOrder, onCommitRootProjectOrder }
}

describe('project header move to top', () => {
  it('moves an ungrouped project to the first slot', () => {
    const repos = [repo('a'), repo('b'), repo('c')]
    const s = setup({ repos, byBucket: new Map([['ungrouped', ['a', 'b', 'c']]]) })
    s.result.current.move(repos[2])
    expect(s.onCommitRepoOrder).toHaveBeenCalledWith(['c', 'a', 'b'])
  })

  it('moves a grouped project above its first sibling', () => {
    const repos = [
      repo('x', { projectGroupId: 'g', projectGroupOrder: 1 }),
      repo('y', { projectGroupId: 'g', projectGroupOrder: 2 })
    ]
    const s = setup({
      repos,
      byBucket: new Map([['group:g', ['x', 'y']]]),
      usesProjectGroupOrdering: true
    })
    s.result.current.move(repos[1])
    expect(s.onCommitProjectGroupOrder).toHaveBeenCalledTimes(1)
    const [moved, groupId, order] = s.onCommitProjectGroupOrder.mock.calls[0]
    expect(moved.id).toBe('y')
    expect(groupId).toBe('g')
    expect(order).toBeLessThan(1)
  })

  it('moves a root project to the top of the root list beside groups', () => {
    const repos = [repo('a'), repo('b')]
    const keys = ['repo:a', 'group:g', 'repo:b']
    const s = setup({
      repos,
      byBucket: new Map([['ungrouped', ['a', 'b']]]),
      rootProjectHeaderKeys: keys,
      usesProjectGroupOrdering: true
    })
    expect(s.result.current.isFirst(repos[0])).toBe(true)
    s.result.current.move(repos[1])
    expect(s.onCommitRootProjectOrder).toHaveBeenCalledWith(keys, 'repo:b', 0)
  })

  it('moves a project to the top of its own host section', () => {
    const repos = [repo('b'), repo('c'), repo('a')]
    const s = setup({
      repos,
      byBucket: new Map([['ungrouped', ['a', 'b', 'c']]]),
      byHostBucket: new Map([
        ['["local","ungrouped"]', ['a']],
        ['["ssh:box","ungrouped"]', ['b', 'c']]
      ])
    })
    expect(s.result.current.isFirst(repos[0], 'ssh:box')).toBe(true)
    s.result.current.move(repos[1], 'ssh:box')
    expect(s.onCommitRepoOrder).toHaveBeenCalledWith(['c', 'b', 'a'])
  })

  it('does nothing when the project is already first', () => {
    const repos = [repo('a'), repo('b')]
    const s = setup({ repos, byBucket: new Map([['ungrouped', ['a', 'b']]]) })
    expect(s.result.current.isFirst(repos[0])).toBe(true)
    expect(s.result.current.isFirst(repos[1])).toBe(false)
    s.result.current.move(repos[0])
    expect(s.onCommitRepoOrder).not.toHaveBeenCalled()
  })
})

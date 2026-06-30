import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  buildProjectNavigationOrder,
  selectProjectNavigationTarget,
  type ProjectNavigationInputs
} from './project-navigation'

function wt(id: string, lastActivityAt = 0, displayName = id): Worktree {
  return { id, displayName, lastActivityAt } as unknown as Worktree
}

const PROJECTS = new Map<string, readonly Worktree[]>([
  ['A', [wt('a1')]],
  ['B', [wt('b1', 1), wt('b2', 2)]],
  ['C', [wt('c1')]]
])

function inputs(overrides: Partial<ProjectNavigationInputs> = {}): ProjectNavigationInputs {
  return {
    orderedProjectKeys: ['A', 'B', 'C'],
    worktreesByProjectKey: PROJECTS,
    activeProjectKey: 'A',
    activeWorktreeId: 'a1',
    lastVisitedAtByWorktreeId: {},
    direction: 'down',
    ...overrides
  }
}

describe('selectProjectNavigationTarget', () => {
  it('returns null when there are no projects', () => {
    expect(
      selectProjectNavigationTarget(inputs({ orderedProjectKeys: [], worktreesByProjectKey: new Map() }))
    ).toBeNull()
  })

  it('moves to the next project on "down" and wraps at the end', () => {
    expect(selectProjectNavigationTarget(inputs({ direction: 'down', activeProjectKey: 'A' }))).toBe(
      'b2'
    )
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'down', activeProjectKey: 'C', activeWorktreeId: 'c1' })
      )
    ).toBe('a1')
  })

  it('moves to the previous project on "up" and wraps at the start', () => {
    expect(selectProjectNavigationTarget(inputs({ direction: 'up', activeProjectKey: 'A' }))).toBe(
      'c1'
    )
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'up', activeProjectKey: 'B', activeWorktreeId: 'b1' })
      )
    ).toBe('a1')
  })

  it('starts at the near end when no project is active', () => {
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'down', activeProjectKey: null, activeWorktreeId: null })
      )
    ).toBe('a1')
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'up', activeProjectKey: null, activeWorktreeId: null })
      )
    ).toBe('c1')
  })

  it('activates the most-recently-focused worktree within the target project', () => {
    // No visits recorded: falls back to higher lastActivityAt (b2 > b1).
    expect(selectProjectNavigationTarget(inputs({ direction: 'down', activeProjectKey: 'A' }))).toBe(
      'b2'
    )
    // A recorded visit on b1 outranks b2's newer activity.
    expect(
      selectProjectNavigationTarget(
        inputs({ direction: 'down', activeProjectKey: 'A', lastVisitedAtByWorktreeId: { b1: 100 } })
      )
    ).toBe('b1')
  })
})

describe('buildProjectNavigationOrder', () => {
  const projectKeyOf = (w: Worktree): string | null =>
    w.id === 'x' ? null : w.id.charAt(0).toUpperCase()

  it('orders projects by first appearance and groups their worktrees', () => {
    const order = buildProjectNavigationOrder(
      [wt('a1'), wt('b1'), wt('b2'), wt('c1')],
      projectKeyOf
    )
    expect(order.orderedProjectKeys).toEqual(['A', 'B', 'C'])
    expect(order.worktreesByProjectKey.get('B')?.map((w) => w.id)).toEqual(['b1', 'b2'])
    expect(order.projectKeyByWorktreeId.get('b2')).toBe('B')
  })

  it('dedupes a worktree by id without reordering or double-counting', () => {
    // A late duplicate must not re-append its project or duplicate membership.
    const order = buildProjectNavigationOrder([wt('a1'), wt('b1'), wt('a1')], projectKeyOf)
    expect(order.orderedProjectKeys).toEqual(['A', 'B'])
    expect(order.worktreesByProjectKey.get('A')?.map((w) => w.id)).toEqual(['a1'])
  })

  it('skips worktrees with no project key', () => {
    const order = buildProjectNavigationOrder([wt('x'), wt('a1')], projectKeyOf)
    expect(order.orderedProjectKeys).toEqual(['A'])
    expect(order.projectKeyByWorktreeId.has('x')).toBe(false)
  })

  it('follows the input order, so a de-pinned list yields section order', () => {
    // Caller drops pinned rows before calling, so pin order never skews this.
    const order = buildProjectNavigationOrder([wt('c1'), wt('a1'), wt('b1')], projectKeyOf)
    expect(order.orderedProjectKeys).toEqual(['C', 'A', 'B'])
  })
})
